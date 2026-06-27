const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS - CORS/504/404 এরর এড়াতে credentials true সহ কনফিগারেশন
app.use(cors({
  origin: process.env.CLIENT_URL || true,
  credentials: true
}));
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ================= FIXED JWKS (Better Auth JWKS Endpoint) =================
const JWKS = createRemoteJWKSet(
  new URL(`${process.env.CLIENT_URL}/api/auth/jwks`),
);

// ================= JWT VERIFY MIDDLEWARE =================
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers?.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized: Missing Token" });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: Token Format Invalid" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload; // Better Auth টোকেন পে-লোড (sub, email, role, status ইত্যাদি থাকবে)
    next();
  } catch (err) {
    console.log("JWT ERROR:", err);
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};


// ================= MAIN FUNCTION =================
async function run() {
  try {
    // await client.connect(); // Vercel/Production deployment এর জন্য এটি কমেন্ট রাখাই ভালো

    const dbName = process.env.AUTH_DB_NAME || "PromptVerse";
    const db = client.db(dbName);

console.log("DB Name:", db.databaseName);

console.log(
  "Collections:",
  await db.listCollections().toArray()
);

    // কালেকশন ডিক্লেয়ারেশন
    const usersCollection = db.collection("user");
    const promptsCollection = db.collection("prompts");
    const bookmarksCollection = db.collection("bookmarks");
    const reportsCollection = db.collection("reports");
    const paymentsCollection = db.collection("payments");


    // ─── ১. প্রম্পট সেভ করার API (SECURED) ───
    app.post("/prompts", verifyToken, async (req, res) => {
      try {
        const prompt = req.body;
        const userEmail = req.user.email;
        const userRole = req.user.role || "user"; // Default role if not present

        // রিকোয়ারমেন্ট: ফ্রি ইউজাররা (role === 'user') সর্বোচ্চ ৩টি প্রম্পট অ্যাড করতে পারবে
        if (userRole === "user") {
          const count = await promptsCollection.countDocuments({ authorEmail: userEmail });
          if (count >= 3) {
            return res.status(403).json({
              success: false,
              message: "Prompt limit reached for free users. Please upgrade to Premium or Creator.",
            });
          }
        }

        const newPrompt = {
          ...prompt,
          authorEmail: userEmail,
          authorRole: userRole,
          copyCount: 0,
          reviews: [],
          status: "pending", // রিকোয়ারমেন্ট: নতুন প্রম্পট ডিফল্টভাবে pending থাকবে
          createdAt: new Date()
        };

        const result = await promptsCollection.insertOne(newPrompt);
        res.json({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ২. অল প্রম্পটস মার্কেটপ্লেস API (PUBLIC - SEARCH, FILTER, SORT, PAGINATION) ───
    app.get("/prompts", async (req, res) => {
      try {
        const { search, category, aiTool, difficulty, sortBy, page = 1, limit = 6 } = req.query;

        // মার্কেটপ্লেসে শুধুমাত্র approved এবং public প্রম্পট দেখাবে
        let query = { status: "approved", visibility: "public" };

        // ১. সার্চ লজিক (Title, Tags, AI Tool)
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { aiTool: { $regex: search, $options: "i" } },
            { tags: { $in: [new RegExp(search, "i")] } }
          ];
        }

        // ২. ফিল্টার লজিক
        if (category) query.category = category;
        if (aiTool) query.aiTool = aiTool;
        if (difficulty) query.difficulty = difficulty;

        // ৩. সর্ট লজিক
        let sortOptions = { createdAt: -1 }; // Default: Latest
        if (sortBy === "mostCopied") sortOptions = { copyCount: -1 };
        if (sortBy === "mostPopular") sortOptions = { "reviews.rating": -1 }; // রেটিং অনুযায়ী

        // ৪. পেজিনেশন লজিক
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const prompts = await promptsCollection
          .find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const totalDocuments = await promptsCollection.countDocuments(query);

        res.json({
          success: true,
          data: prompts,
          meta: {
            total: totalDocuments,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(totalDocuments / limit)
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৩. ক্রিয়েটর ড্যাশবোর্ড অ্যানালিটিক্স (SECURED - MONGODB AGGREGATION) ───
    app.get("/creator/analytics", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        // মঙ্গোডিবি অ্যাগ্রিগেশন পাইপলাইন ব্যবহার করে প্রম্পটের টোটাল কাউন্ট এবং টোটাল কপির যোগফল বের করা
        const statsAggregation = await promptsCollection.aggregate([
          { $match: { authorEmail: userEmail } },
          {
            $group: {
              _id: null,
              totalPrompts: { $sum: 1 },
              totalCopies: { $sum: "$copyCount" }
            }
          }
        ]).toArray();

        // বুকমার্ক কাউন্ট বের করা
        const totalBookmarks = await bookmarksCollection.countDocuments({ authorEmail: userEmail });

        const stats = statsAggregation[0] ? {
          totalPrompts: statsAggregation[0].totalPrompts,
          totalCopies: statsAggregation[0].totalCopies || 0,
          totalBookmarks: totalBookmarks
        } : { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 };

        // Recharts গ্রাফের জন্য ডেটা প্রিপেয়ার করা (গ্রোথ অ্যানালিটিক্স)
        const chartDataAggregation = await promptsCollection.aggregate([
          { $match: { authorEmail: userEmail } },
          {
            $group: {
              _id: { $dateToString: { format: "%b", date: "$createdAt" } },
              copies: { $sum: "$copyCount" }
            }
          },
          { $project: { name: "$_id", copies: 1, _id: 0 } }
        ]).toArray();

        // চার্টের মাসের সিকোয়েন্স ঠিক রাখার জন্য মান্থলি অর্ডারিং ম্যাপ করা যেতে পারে, অথবা ডিরেক্ট পাঠানো যায়
        res.json({ success: true, stats, chartData: chartDataAggregation });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৪. একক প্রম্পট ডিটেইলস ও প্রিমিয়াম লক হ্যান্ডেল (PUBLIC/OPTIONAL AUTH) ───
    app.get("/prompts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.query.email; // ফ্রন্টএন্ড থেকে কুয়েরি প্যারামিটারে লগইন থাকা ইউজারের ইমেইল আসবে

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid Prompt ID" });
        }

        const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
        if (!prompt) {
          return res.status(404).json({ success: false, message: "Prompt not found" });
        }

        // ইউজার প্রিমিয়াম, ক্রিয়েটর নাকি অ্যাডমিন তা চেক করা হচ্ছে
        let isPremiumUser = false;
        if (userEmail) {
          const user = await usersCollection.findOne({ email: userEmail });
          if (user && (user.status === "Premium" || user.role === "creator" || user.role === "admin")) {
            isPremiumUser = true;
          }
        }

        // রিকোয়ারমেন্ট: Private (Premium) প্রম্পট হলে কন্টেন্ট লক করে দেওয়া হবে যদি ইউজার প্রিমিয়াম না হয়
        let responseData = { ...prompt };
        if (prompt.visibility === "private" && !isPremiumUser) {
          responseData.promptContent = "LOCKED_PREMIUM"; // ফ্রন্টএন্ডে এটি দেখে ব্লার/লক মেসেজ দেখাবেন
        }

        // বুকমার্ক স্ট্যাটাস চেক
        let bookmarked = false;
        if (userEmail) {
          const bookmarkExists = await bookmarksCollection.findOne({ userEmail, promptId: id });
          if (bookmarkExists) bookmarked = true;
        }

        res.json({
          success: true,
          data: responseData,
          isPremiumUser,
          isBookmarked: bookmarked,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৫. বুকমার্ক টগল API (SECURED) ───
    app.post("/prompts/:id/bookmark", verifyToken, async (req, res) => {
      try {
        const promptId = req.params.id;
        const userEmail = req.user.email;

        const query = { userEmail, promptId };
        const existingBookmark = await bookmarksCollection.findOne(query);

        if (existingBookmark) {
          await bookmarksCollection.deleteOne(query);
          return res.json({ success: true, bookmarked: false, message: "Bookmark removed" });
        } else {
          await bookmarksCollection.insertOne({ ...query, createdAt: new Date() });
          return res.json({ success: true, bookmarked: true, message: "Prompt bookmarked" });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৬. কপি কাউন্ট বাড়ানোর API (PUBLIC/PATCH) ───
    app.patch("/prompts/:id/copy", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid ID" });

        await promptsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { copyCount: 1 } }
        );
        res.json({ success: true, message: "Copy count incremented" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৭. রিভিউ ও রেটিং অ্যাড করার API (SECURED) ───
    app.post("/prompts/:id/reviews", verifyToken, async (req, res) => {
      try {
        const promptId = req.params.id;
        const { name, email } = req.user;
        const { rating, comment } = req.body;

        const newReview = {
          name,
          email,
          rating: parseInt(rating) || 5,
          comment,
          date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
        };

        await promptsCollection.updateOne(
          { _id: new ObjectId(promptId) },
          { $push: { reviews: newReview } }
        );

        res.json({ success: true, message: "Review added", review: newReview });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৮. রিপোর্ট সাবমিট করার API (SECURED) ───
    app.post("/prompts/:id/report", verifyToken, async (req, res) => {
      try {
        const promptId = req.params.id;
        const userEmail = req.user.email;
        const { reason, description } = req.body;

        const reportData = {
          promptId: new ObjectId(promptId),
          userEmail,
          reason,
          description,
          status: "pending",
          createdAt: new Date(),
        };

        await reportsCollection.insertOne(reportData);
        res.json({ success: true, message: "Report submitted successfully" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৯. পেমেন্ট সাকসেস হ্যান্ডেলার (SECURED) ───
    app.post("/payments/success", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const { transactionId, amount } = req.body;

        await paymentsCollection.insertOne({
          transactionId,
          email: userEmail,
          amount,
          date: new Date()
        });

        // ইউজার কালেকশনে স্ট্যাটাস Premium করে দেওয়া
        await db.collection("users").updateOne(
          { email: userEmail },
          { $set: { status: "Premium" } }
        );

        res.json({ success: true, message: "Subscription upgraded to Premium!" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ১০. কারেন্ট ইউজারের নিজস্ব প্রম্পট লিস্ট পাওয়ার API (SECURED) ───
app.get("/my-prompts", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email; // টোকেন থেকে ইউজারের ইমেইল নেওয়া হচ্ছে

    // শুধুমাত্র এই ইউজারের প্রম্পটগুলোই ডেটাবেজ থেকে খোঁজা হবে
    const userPrompts = await promptsCollection
      .find({ authorEmail: userEmail })
      .sort({ createdAt: -1 }) // লেটেস্টগুলো আগে দেখাবে
      .toArray();

    res.json({
      success: true,
      data: userPrompts,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ১১. প্রম্পট ডিলিট করার API (SECURED) ───
app.delete("/prompts/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const userEmail = req.user.email;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    // সিকিউরিটি চেক: ইউজার নিজের প্রম্পট ছাড়া অন্যের প্রম্পট ডিলিট করতে পারবে না
    const result = await promptsCollection.deleteOne({
      _id: new ObjectId(id),
      authorEmail: userEmail
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Prompt not found or unauthorized" });
    }

    res.json({ success: true, message: "Prompt deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ১২. কারেন্ট ইউজারের বুকমার্ক করা প্রম্পট লিস্ট পাওয়ার API (SECURED - AGGREGATION) ───
app.get("/my-bookmarks", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // Aggregation Pipeline ব্যবহার করে bookmarks এর সাথে prompts কালেকশন জয়েন করা হচ্ছে
    const bookmarkedPrompts = await bookmarksCollection.aggregate([
      { 
        $match: { userEmail: userEmail } 
      },
      {
        $addFields: {
          promptObjectId: { $toObjectId: "$promptId" } // string promptId কে ObjectId তে কনভার্ট
        }
      },
      {
        $lookup: {
          from: "prompts",             // যে কালেকশনের সাথে জয়েন হবে
          localField: "promptObjectId", // bookmarks কালেকশনের ফিল্ড
          foreignField: "_id",          // prompts কালেকশনের ফিল্ড
          as: "promptDetails"           // আউটপুট ফিল্ডের নাম
        }
      },
      {
        $unwind: "$promptDetails" // অ্যারে থেকে অবজেক্টে নিয়ে আসা
      },
      {
        $project: {
          _id: "$promptDetails._id", // প্রম্পটের অরিজিনাল আইডি পাস করা যাতে ফ্রন্টএন্ডে সুবিধা হয়
          bookmarkId: "$_id",        // বুকমার্কের নিজস্ব আইডি
          title: "$promptDetails.title",
          category: "$promptDetails.category",
          aiTool: "$promptDetails.aiTool",
          copyCount: "$promptDetails.copyCount",
          authorEmail: "$promptDetails.authorEmail" // ক্রিয়েটরের ইমেইল বা নাম ট্র্যাকের জন্য
        }
      }
    ]).toArray();

    res.json({
      success: true,
      data: bookmarkedPrompts
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ১৩. কারেন্ট ইউজারের দেওয়া সব রিভিউ ও রেটিং পাওয়ার API (SECURED - AGGREGATION) ───
app.get("/my-reviews", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email; // টোকেন থেকে লগইন করা ইউজারের ইমেইল নেওয়া হচ্ছে

    const myReviews = await promptsCollection.aggregate([
      // ১. শুধুমাত্র যে প্রম্পটগুলোতে রিভিউ অ্যারে খালি না সেগুলো ফিল্টার করা
      { $match: { "reviews.email": userEmail } },
      
      // ২. রিভিউ অ্যারে ভেঙে সিঙ্গেল অবজেক্টে রূপান্তর করা
      { $unwind: "$reviews" },
      
      // ৩. শুধুমাত্র কারেন্ট ইউজারের করা রিভিউগুলো ম্যাচ করা
      { $match: { "reviews.email": userEmail } },
      
      // ৪. ফ্রন্টএন্ডের মক ডাটা ফরম্যাটের সাথে ফিল্ডগুলো ম্যাচ করে প্রজেক্ট করা
      {
        $project: {
          _id: { $concat: [ { $toString: "$_id" }, "-", "$reviews.date" ] }, // ইউনিক কি জেনারেট
          promptId: "$_id",
          promptTitle: "$title",
          rating: "$reviews.rating",
          comment: "$reviews.comment",
          createdAt: "$reviews.date" // রিভিউ দেওয়ার ডেট
        }
      }
    ]).toArray();

    res.json({
      success: true,
      data: myReviews
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ১৪. ইউজার ড্যাশবোর্ড ওভারভিউ স্ট্যাটস API (SECURED) ───
app.get("/user/dashboard-stats", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;

    // ১. ইউজারের সাবস্ক্রিপশন বা প্ল্যান স্ট্যাটাস দেখা (users কালেকশন থেকে)
    const user = await usersCollection.findOne({ email: userEmail });
    const subscription = user?.status || "Free";

    // ২. টোটাল বুকমার্ক বা সেভ করা প্রম্পটের সংখ্যা বের করা
    const savedCount = await bookmarksCollection.countDocuments({ userEmail });

    // ৩. ইউজারের দেওয়া টোটাল রিভিউ কাউন্ট বের করা (prompts এর ভেতরের reviews অ্যারে ফিল্টার)
    const reviewStats = await promptsCollection.aggregate([
      { $match: { "reviews.email": userEmail } },
      { $unwind: "$reviews" },
      { $match: { "reviews.email": userEmail } },
      { $count: "totalReviews" }
    ]).toArray();

    const reviewCount = reviewStats[0]?.totalReviews || 0;

    // ৪. রিসেন্ট অ্যাক্টিভিটি জেনারেট করা (ডাটাবেজের রিয়েল ডাটা অনুযায়ী মিক্সড হিস্ট্রি)
    const recentSaved = await bookmarksCollection.find({ userEmail }).sort({ createdAt: -1 }).limit(2).toArray();
    
    const activities = [];
    recentSaved.forEach((b, index) => {
      activities.push({
        id: `b_${index}`,
        message: "You bookmarked a prompt from the marketplace",
        time: b.createdAt ? new Date(b.createdAt).toLocaleDateString() : "Recently"
      });
    });

    if (activities.length === 0) {
      activities.push({ id: "def_1", message: "Welcome to PromptVerse! Explore the marketplace to add activity.", time: "Just now" });
    }

    res.json({
      success: true,
      stats: {
        savedCount,
        reviewCount,
        subscription
      },
      activities
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

    // ─── GET USER PROMPT COUNT (SECURED) ───
app.get("/prompts/count/:email", verifyToken, async (req, res) => {
  try {
    const email = req.params.email;

    // অন্য কারো count দেখতে পারবে না
    if (req.user.email !== email) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }

    const count = await promptsCollection.countDocuments({
      authorEmail: email,
    });

    res.json({
      success: true,
      count,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});



// =============ADMIN==============
    // আপনার JWT ভেরিফাই করার পর এই মিডলওয়্যারটি চলবে
const verifyAdmin = async (req, res, next) => {
  try {
    const email = req.user?.email;

    const user = await usersCollection.findOne({ email }); // ✅ usersCollection

    console.log("DB User:", user);

    if (!user || user.role !== "admin") {
      return res.status(403).json({
        message: "Forbidden Access! Admin only.",
      });
    }

    next();
  } catch (error) {
    console.error("Verify Admin Error:", error);
    res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

// ১. অ্যানালিটিক্স API (SECURED - Total Users, Prompts, Reviews, Copies)
app.get('/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();
    const totalPrompts = await promptsCollection.countDocuments();
    
    // মঙ্গোডিবি অ্যাগ্রিগেশন পাইপলাইন দিয়ে সব প্রম্পটের টোটাল কপির যোগফল বের করা
    const copyStats = await promptsCollection.aggregate([
      {
        $group: {
          _id: null,
          totalCopies: { $sum: "$copyCount" }
        }
      }
    ]).toArray();
    const totalCopies = copyStats[0]?.totalCopies || 0;

    // মঙ্গোডিবি অ্যাগ্রিগেশন পাইপলাইন দিয়ে সব প্রম্পটের মোট রিভিউ সংখ্যা বের করা
    const reviewStats = await promptsCollection.aggregate([
      { $unwind: "$reviews" },
      { $count: "totalReviews" }
    ]).toArray();
    const totalReviews = reviewStats[0]?.totalReviews || 0;

    res.json({
      success: true,
      stats: { totalUsers, totalPrompts, totalReviews, totalCopies }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ২. সব ইউজারদের ডাটা নিয়ে আসার API (SECURED)
app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await usersCollection.find().toArray();
    res.json(result); // ফ্রন্টএন্ড সরাসরি অ্যারে আশা করছে
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ৩. ইউজারের রোল পরিবর্তন করার API (SECURED)
app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { role } = req.body;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid User ID" });
    }

    const filter = { _id: new ObjectId(id) };
    const updateDoc = { $set: { role: role } };
    
    const result = await usersCollection.updateOne(filter, updateDoc);
    res.json({ success: true, message: "User role updated successfully", result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ৪. সব প্রম্পট দেখার API (SECURED)
app.get('/admin/prompts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await promptsCollection.find().sort({ createdAt: -1 }).toArray();
    res.json(result); // ফ্রন্টএন্ড সরাসরি অ্যারে আশা করছে
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ৫. প্রম্পট Approve বা Reject করার API (SECURED)
app.patch('/prompts/status/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status, feedback } = req.body; // status: 'approved' বা 'rejected'
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid Prompt ID" });
    }

    const filter = { _id: new ObjectId(id) };
    const updateDoc = {
      $set: { 
        status: status, 
        feedback: feedback || "" 
      }
    };
    
    const result = await promptsCollection.updateOne(filter, updateDoc);
    res.json({ success: true, message: `Prompt status updated to ${status}`, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ৬. সব পেমেন্ট ডাটা tabular ফর্মে দেখানোর API (SECURED)
app.get('/admin/payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await paymentsCollection.find().sort({ date: -1 }).toArray();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ৭. সব রিপোর্টেড প্রম্পট দেখার API (SECURED)
app.get('/admin/reported-prompts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    // Aggregation ব্যবহার করে reports কালেকশনের সাথে prompts কালেকশন জয়েন করা
    const reportedPrompts = await reportsCollection.aggregate([
      {
        $addFields: { promptObjectId: { $toObjectId: "$promptId" } }
      },
      {
        $lookup: {
          from: "prompts",
          localField: "promptObjectId",
          foreignField: "_id",
          as: "promptDetails"
        }
      },
      { $unwind: "$promptDetails" },
      {
        $project: {
          _id: 1,
          promptId: "$promptDetails._id",
          promptTitle: "$promptDetails.title",
          creatorEmail: "$promptDetails.authorEmail",
          reporterEmail: "$userEmail",
          reason: 1,
          description: 1,
          status: 1,
          createdAt: 1
        }
      }
    ]).toArray();

    res.json({ success: true, data: reportedPrompts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});



// DONT TOUCH

    console.log("MongoDB connected successfully via JWKS architecture");
  } finally {
    // Keep alive
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Marketplace API Server Running smoothly!");
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});