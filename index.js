const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");

dotenv.config();

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 5000;

// CORS কনফিগারেশন
app.use(
  cors({
    origin: process.env.CLIENT_URL || true,
    credentials: true,
  }),
);
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ================= FIXED JWKS =================
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
    return res
      .status(401)
      .json({ message: "Unauthorized: Token Format Invalid" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);

    // Better-Auth এর বিভিন্ন ফরম্যাট হ্যান্ডেল করার জন্য ইমেইল এক্সট্র্যাকশন ফিক্স করা হলো
    req.user = {
      email: payload.email || payload.user?.email || payload.sub,
      role: payload.role || "user",
      name: payload.name || payload.user?.name,
    };

    console.log("👉 Dashboard API Hit By User:", req.user.email);
    next();
  } catch (err) {
    console.error("JWT ERROR:", err);
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};

// ================= MAIN FUNCTION =================
async function run() {
  try {
    const dbName = process.env.AUTH_DB_NAME || "PromptVerse";
    const db = client.db(dbName);

    console.log("DB Name:", db.databaseName);

    const usersCollection = db.collection("user");
    const promptsCollection = db.collection("prompts");
    const reviewsCollection = db.collection("reviews");
    const bookmarksCollection = db.collection("bookmarks");
    const reportsCollection = db.collection("reports");
    const paymentsCollection = db.collection("payments");

    // ─── ১. প্রম্পট সেভ করার API (SECURED) ───
    app.post("/prompts", verifyToken, async (req, res) => {
      try {
        const prompt = req.body;
        const userEmail = req.user.email;
        const userRole = req.user.role || "user";

        if (userRole === "user") {
          const count = await promptsCollection.countDocuments({
            authorEmail: userEmail,
          });
          if (count >= 3) {
            return res.status(403).json({
              success: false,
              message:
                "Prompt limit reached for free users. Please upgrade to Premium or Creator.",
            });
          }
        }

        const newPrompt = {
          ...prompt,
          authorEmail: userEmail,
          authorRole: userRole,
          copyCount: 0,
          reviews: [],
          status: "pending",
          visibility: prompt.visibility || "public", // ডিফল্ট বা ইউজার সিলেক্টেড ভিজিবিলিটি
          createdAt: new Date(),
        };

        const result = await promptsCollection.insertOne(newPrompt);
        res.json({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ২. অল প্রম্পটস মার্কেটপ্লেস API (WITH BLUR/LOCK LOGIC FOR PRIVATE PROMPTS) ───
    app.get("/prompts", async (req, res) => {
      try {
        const {
          search,
          category,
          aiTool,
          difficulty,
          sortBy,
          page = 1,
          limit = 6,
          email, // ফ্রন্টএন্ড থেকে পাঠানো ইউজারের ইমেইল
        } = req.query;

        // মার্কেটপ্লেসে শুধুমাত্র approved প্রম্পট দেখাবে
        let query = { status: "approved" };

        if (search) {
          query.$or = [
            { title: { $regex: search, $options: "i" } },
            { aiTool: { $regex: search, $options: "i" } },
            { tags: { $in: [new RegExp(search, "i")] } },
          ];
        }

        if (category) query.category = category;
        if (aiTool) query.aiTool = aiTool;
        if (difficulty) query.difficulty = difficulty;

        let sortOptions = { createdAt: -1 };
        if (sortBy === "mostCopied") sortOptions = { copyCount: -1 };
        if (sortBy === "mostPopular") sortOptions = { "reviews.rating": -1 };

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const prompts = await promptsCollection
          .find(query)
          .sort(sortOptions)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const totalDocuments = await promptsCollection.countDocuments(query);

        // ১. ইউজার প্রিমিয়াম মেম্বার বা এডমিন কিনা তা ডাটাবেজ থেকে চেক করা
        let isPremiumUser = false;
        if (email && email !== "undefined" && email !== "") {
          const user = await usersCollection.findOne({ email });
          // ক্রিয়েটর যদি ফ্রি প্ল্যানে থাকে, সে অন্যের প্রিমিয়াম কন্টেন্ট দেখতে পাবে না।
          // তাই শুধুমাত্র user.status === "Premium" অথবা admin গ্লোবাল অ্যাক্সেস পাবে।
          if (user && (user.status === "Premium" || user.role === "admin")) {
            isPremiumUser = true;
          }
        }

        // ২. প্রসেসড ডেটা জেনারেট করা
        const processedPrompts = prompts.map((prompt) => {
          let updatedPrompt = { ...prompt };

          const originalContent = prompt.promptContent || prompt.content || "";

          // চেক করি ইউজার নিজেই এই প্রম্পটের ক্রিয়েটর বা মালিক কিনা
          const isAuthor = email && prompt.authorEmail === email;

          // প্রম্পট যদি প্রাইভেট (Premium) হয় এবং ইউজার যদি প্রিমিয়াম না হয় প্লাস সে যদি মালিকও না হয়
          if (prompt.visibility === "private" && !isPremiumUser && !isAuthor) {
            updatedPrompt.content = "LOCKED_PREMIUM";
            updatedPrompt.promptContent = "LOCKED_PREMIUM";
          } else {
            // প্রিমিয়াম ইউজার, এডমিন অথবা নিজের তৈরি প্রম্পট হলে কন্টেন্ট দেখা যাবে
            updatedPrompt.content = originalContent;
            updatedPrompt.promptContent = originalContent;
          }

          return updatedPrompt;
        });

        // 🎯 রেসপন্সে processedPrompts এর সাথে 'isPremiumUser' ফ্ল্যাগটি পাঠানো হলো
        res.json({
          success: true,
          data: processedPrompts,
          isPremiumUser: isPremiumUser,
          meta: {
            total: totalDocuments,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(totalDocuments / limit),
          },
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // User Dashboard stats
    // আপনার ইউজার ড্যাশবোর্ডের ডেটার জন্য ব্যাকএন্ড রাউট
    app.get("/user/dashboard-stats", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user?.email;

        // ইউজার নিজে কয়টা প্রম্পট অ্যাড করেছে তার রিয়াল কাউন্ট (ডক রিকোয়ারমেন্ট ৩টি লিমিটের জন্য)
        const promptCount = await promptsCollection.countDocuments({
          authorEmail: userEmail,
        });

        const savedCount = await bookmarksCollection.countDocuments({
          userEmail: userEmail,
        });
        const reviewCount = await reviewsCollection.countDocuments({
          email: userEmail,
        });

        const userInfo = await usersCollection.findOne({ email: userEmail });
        const subscription = userInfo?.subscription || "Free";

        return res.status(200).json({
          success: true,
          stats: {
            savedCount,
            reviewCount,
            subscription,
            promptCount: promptCount || 0, // এই যে ডাইনামিক কাউন্ট পাঠিয়ে দিলাম!
          },
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    });

    // ─── ১২.১. কারেন্ট ইউজারের নিজের দেওয়া সব রিভিউ এর লিস্ট ───
    app.get("/my-reviews", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        // database theke shudhu oi prompt gulo nibe jekhane "reviews" list er bhetor amar email ase
        const myReviewedPrompts = await promptsCollection
          .aggregate([
            { $match: { "reviews.email": userEmail } },
            {
              $project: {
                _id: 1,
                title: 1, // Prompt er Title
                category: 1, // Prompt er Category
                aiTool: 1, // Prompt er AI Tool (যেমন: ChatGPT, Midjourney)
                // dynamic bhabe prompt er reviews array theke shudhu amr review-ta filter kore ana
                myReviewDetails: {
                  $filter: {
                    input: "$reviews",
                    as: "review",
                    cond: { $eq: ["$$review.email", userEmail] },
                  },
                },
              },
            },
            { $unwind: "$myReviewDetails" },
            {
              $project: {
                _id: 1,
                promptTitle: "$title",
                category: 1,
                aiTool: 1,
                rating: "$myReviewDetails.rating",
                comment: "$myReviewDetails.comment",
                date: "$myReviewDetails.date",
              },
            },
          ])
          .toArray();

        res.json({ success: true, data: myReviewedPrompts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── ৩. ক্রিয়েটর ড্যাশবোর্ড অ্যানালিটিক্স ───
    app.get("/creator/analytics", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        // ১. সামারি স্ট্যাটস (Total Prompts, Total Copies)
        const statsAggregation = await promptsCollection
          .aggregate([
            { $match: { authorEmail: userEmail } },
            {
              $group: {
                _id: null,
                totalPrompts: { $sum: 1 },
                totalCopies: { $sum: "$copyCount" },
              },
            },
          ])
          .toArray();

        // ২. বুকমার্ক কাউন্ট
        const totalBookmarks = await bookmarksCollection.countDocuments({
          authorEmail: userEmail, // ডক অনুযায়ী যে প্রম্পটগুলো এই ইউজারের বুকমার্ক করা
        });

        const stats = statsAggregation[0]
          ? {
              totalPrompts: statsAggregation[0].totalPrompts,
              totalCopies: statsAggregation[0].totalCopies || 0,
              totalBookmarks: totalBookmarks,
            }
          : { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 };

        // ৩. চার্ট ডাটা (ডক রিকোয়ারমেন্ট: Total Copies & Prompt Growth)
        const chartDataAggregation = await promptsCollection
          .aggregate([
            { $match: { authorEmail: userEmail } },
            {
              $group: {
                // মাসের নাম অনুযায়ী গ্রুপ (যেমন: Jan, Feb, Mar)
                _id: { $dateToString: { format: "%b", date: "$createdAt" } },
                copies: { $sum: "$copyCount" }, // Total Copies
                promptCount: { $sum: 1 }, // Prompt Growth (কয়টা প্রম্পট যোগ হইছে)
              },
            },
            {
              $project: {
                name: "$_id",
                copies: 1,
                prompts: "$promptCount", // Recharts-এ ব্যবহারের জন্য সহজ নাম
                _id: 0,
              },
            },
            // মাসের ক্রমানুসারে সাজানোর জন্য (ঐচ্ছিক কিন্তু সুন্দর দেখাবে)
            { $sort: { name: 1 } },
          ])
          .toArray();

        res.json({ success: true, stats, chartData: chartDataAggregation });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৪. একক প্রম্পট ডিটেইলস ও প্রিমিয়াম লক হ্যান্ডেল ───
    app.get("/prompts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.query.email;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid Prompt ID" });
        }

        const prompt = await promptsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!prompt) {
          return res
            .status(404)
            .json({ success: false, message: "Prompt not found" });
        }

        let isPremiumUser = false;
        if (userEmail) {
          const user = await usersCollection.findOne({ email: userEmail });
          if (
            user &&
            (user.status === "Premium" ||
              user.role === "creator" ||
              user.role === "admin")
          ) {
            isPremiumUser = true;
          }
        }

        let responseData = { ...prompt };
        if (prompt.visibility === "private" && !isPremiumUser) {
          responseData.promptContent = "LOCKED_PREMIUM";
        }

        let bookmarked = false;
        if (userEmail) {
          const bookmarkExists = await bookmarksCollection.findOne({
            userEmail,
            promptId: id,
          });
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

    // ─── ৫. বুকমার্ক টগল API ───
    app.post("/prompts/:id/bookmark", verifyToken, async (req, res) => {
      try {
        const promptId = req.params.id;
        const userEmail = req.user.email;

        const query = { userEmail, promptId };
        const existingBookmark = await bookmarksCollection.findOne(query);

        if (existingBookmark) {
          await bookmarksCollection.deleteOne(query);
          return res.json({
            success: true,
            bookmarked: false,
            message: "Bookmark removed",
          });
        } else {
          await bookmarksCollection.insertOne({
            ...query,
            createdAt: new Date(),
          });
          return res.json({
            success: true,
            bookmarked: true,
            message: "Prompt bookmarked",
          });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৬. কপি কাউন্ট বাড়ানোর API ───
    app.patch("/prompts/:id/copy", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id))
          return res.status(400).json({ message: "Invalid ID" });

        await promptsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { copyCount: 1 } },
        );
        res.json({ success: true, message: "Copy count incremented" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৭. রিভিউ ও রেটিং অ্যাড করার API ───
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
          date: new Date().toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
        };

        await promptsCollection.updateOne(
          { _id: new ObjectId(promptId) },
          { $push: { reviews: newReview } },
        );

        res.json({ success: true, message: "Review added", review: newReview });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ─── ৮. রিপোর্ট সাবমিট করার API ───
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

    // ─── ৮.৫ স্ট্রাইপ পেমেন্ট ইনটেন্ট তৈরি (নতুন যোগ করতে হবে) ───
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      try {
        const price = 500; // $5.00 কে সেন্টে কনভার্ট করা হয়েছে (5 * 100)

        const paymentIntent = await stripe.paymentIntents.create({
          amount: price,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({
          success: true,
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── ৯. পেমেন্ট সাকসেস হ্যান্ডেলার ───
    app.post("/payments/success", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const { transactionId, amount } = req.body;

        // ১. পেমেন্ট কালেকশনে ডাটা ইনসার্ট করা
        await paymentsCollection.insertOne({
          transactionId,
          email: userEmail,
          amount,
          date: new Date(),
        });

        // ২. ইউজার কালেকশনে স্ট্যাটাস এবং সাবস্ক্রিপশন দুটিই "Premium" করে দেওয়া (এখানেই পরিবর্তন করবেন)
        await usersCollection.updateOne(
          { email: userEmail },
          { $set: { subscription: "Premium", status: "Premium" } },
        );

        res.json({
          success: true,
          message: "Subscription upgraded to Premium!",
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    // ─── ১০. কারেন্ট ইউজারের নিজস্ব প্রম্পট লিস্ট ───
    app.get("/my-prompts", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const userPrompts = await promptsCollection
          .find({ authorEmail: userEmail })
          .sort({ createdAt: -1 })
          .toArray();

        res.json({ success: true, data: userPrompts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── ১১. প্রম্পট ডিলিট করার API ───
    app.delete("/prompts/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .json({ success: false, message: "Invalid ID" });
        }

        const result = await promptsCollection.deleteOne({
          _id: new ObjectId(id),
          authorEmail: userEmail,
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Prompt not found or unauthorized",
          });
        }

        res.json({ success: true, message: "Prompt deleted successfully" });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── ১২. কারেন্ট ইউজারের বুকমার্ক করা প্রম্পট লিস্ট ───
    app.get("/my-bookmarks", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        const bookmarkedPrompts = await bookmarksCollection
          .aggregate([
            { $match: { userEmail: userEmail } },
            { $match: { promptId: { $regex: "^[0-9a-fA-F]{24}$" } } },
            {
              $addFields: {
                promptObjectId: { $toObjectId: "$promptId" },
              },
            },
            {
              $lookup: {
                from: "prompts",
                localField: "promptObjectId",
                foreignField: "_id",
                as: "promptDetails",
              },
            },
            { $unwind: "$promptDetails" },
            {
              $project: {
                _id: "$promptDetails._id",
                bookmarkId: "$_id",
                title: "$promptDetails.title",
                category: "$promptDetails.category",
                aiTool: "$promptDetails.aiTool",
                copyCount: "$promptDetails.copyCount",
                authorEmail: "$promptDetails.authorEmail",
              },
            },
          ])
          .toArray();

        res.json({ success: true, data: bookmarkedPrompts });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── ১৩. টপ ক্রিয়েটরদের ডাইনামিক লিস্ট নিয়ে আসার API ───
    app.get("/top-creators", async (req, res) => {
      try {
        const topCreators = await promptsCollection
          .aggregate([
            // ১. শুধুমাত্র approved প্রম্পটগুলো ফিল্টার করা হলো
            { $match: { status: "approved" } },
            // ২. ক্রিয়েটরের ইমেইল অনুযায়ী গ্রুপ করে স্ট্যাটস ক্যালকুলেট করা
            {
              $group: {
                _id: "$authorEmail",
                name: { $first: "$authorName" }, // প্রম্পটে authorName সেভ করা থাকতে হবে
                role: { $first: "$authorRole" },
                totalPrompts: { $sum: 1 },
                totalCopies: { $sum: "$copyCount" },
                averageRating: {
                  $avg: { $ifNull: [{ $avg: "$reviews.rating" }, 5] },
                },
              },
            },
            // ৩. সবচেয়ে বেশি কপি হওয়া ক্রিয়েটরদের প্রথমে রাখা
            { $sort: { totalCopies: -1 } },
            // ৪. টপ ৬ জন ক্রিয়েটর নেওয়া
            { $limit: 6 },
          ])
          .toArray();

        // কালার এবং ব্যাজ ডাইনামিক করার জন্য ম্যাপ করা
        const colors = [
          "#7C3AED",
          "#F59E0B",
          "#94A3B8",
          "#CD7C2F",
          "#06B6D4",
          "#10B981",
        ];
        const badges = ["👑", "🥇", "🥈", "🥉", "⭐", "⭐"];

        const formattedCreators = topCreators.map((creator, index) => {
          const name = creator.name || creator._id.split("@")[0]; // নাম না থাকলে ইমেইল থেকে নেওয়া
          return {
            name: name.charAt(0).toUpperCase() + name.slice(1),
            role:
              creator.role === "creator"
                ? "AI Prompt Creator"
                : "Community User",
            prompts: creator.totalPrompts,
            rating: parseFloat(creator.averageRating.toFixed(1)) || 5.0,
            badge: badges[index] || "⭐",
            color: colors[index] || "#64748B",
            initials: name.substring(0, 2).toUpperCase(),
          };
        });

        res.json({ success: true, data: formattedCreators });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    // ─── ১৪. ইউজার রিভিউ নিয়ে আসার API ───
    // ─── ১৪. ইউজার রিভিউ নিয়ে আসার ডাইনামিক API ───
    app.get("/customer-reviews", async (req, res) => {
      try {
        const reviewsData = await promptsCollection
          .aggregate([
            { $unwind: "$reviews" },
            { $sort: { "reviews.createdAt": -1 } },
            { $limit: 6 },
            {
              $project: {
                // ডাটাবেজে নাম যেভাবে থাকতে পারে (সবগুলো সম্ভাব্য নাম চেক করা হচ্ছে)
                name: {
                  $ifNull: [
                    "$reviews.reviewerName",
                    "$reviews.username",
                    "$reviews.name",
                    "$reviews.userEmail", // নাম না থাকলে ইমেইল দেখাবে
                    "Anonymous User",
                  ],
                },
                role: { $ifNull: ["$reviews.reviewerRole", "AI Enthusiast"] },
                text: { $ifNull: ["$reviews.comment", "$reviews.text"] },
                rating: "$reviews.rating",
              },
            },
          ])
          .toArray();

        const colors = [
          "#7C3AED",
          "#06B6D4",
          "#10B981",
          "#F59E0B",
          "#EF4444",
          "#8B5CF6",
        ];

        const formattedReviews = reviewsData.map((review, index) => {
          let reviewerName = review.name;

          // যদি ইমেইল চলে আসে, তবে @ এর আগের অংশটুকু নাম হিসেবে নেওয়া হবে
          if (reviewerName.includes("@")) {
            reviewerName = reviewerName.split("@")[0];
          }

          // নামের প্রথম অক্ষর বড় হাতের করা
          reviewerName =
            reviewerName.charAt(0).toUpperCase() + reviewerName.slice(1);

          // ইনিশিয়াল জেনারেট করা (যেমন: John Doe -> JD)
          const words = reviewerName.split(" ");
          const initials = words
            .map((w) => w[0])
            .join("")
            .substring(0, 2)
            .toUpperCase();

          return {
            name: reviewerName,
            role: review.role,
            text: review.text || "Great prompt! Highly recommended.",
            rating: review.rating || 5,
            initials: initials || "U",
            color: colors[index % colors.length],
          };
        });

        res.json({ success: true, data: formattedReviews });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // ─── 🔑 [ADMIN ONLY ENDPOINTS] ───
    const verifyAdmin = async (req, res, next) => {
      try {
        const email = req.user?.email;
        const user = await usersCollection.findOne({ email });

        if (!user || user.role !== "admin") {
          return res
            .status(403)
            .json({ message: "Forbidden Access! Admin only." });
        }
        next();
      } catch (error) {
        console.error("Verify Admin Error:", error);
        res.status(500).json({ message: "Internal Server Error" });
      }
    };

    app.get("/admin/analytics", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalPrompts = await promptsCollection.countDocuments();

        const copyStats = await promptsCollection
          .aggregate([
            { $group: { _id: null, totalCopies: { $sum: "$copyCount" } } },
          ])
          .toArray();
        const totalCopies = copyStats[0]?.totalCopies || 0;

        const reviewStats = await promptsCollection
          .aggregate([{ $unwind: "$reviews" }, { $count: "totalReviews" }])
          .toArray();
        const totalReviews = reviewStats[0]?.totalReviews || 0;

        res.json({
          success: true,
          stats: { totalUsers, totalPrompts, totalReviews, totalCopies },
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await usersCollection.find().toArray();
        res.json(result);
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;
        const { role } = req.body;
        if (!ObjectId.isValid(id))
          return res
            .status(400)
            .json({ success: false, message: "Invalid User ID" });

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } },
        );
        res.json({
          success: true,
          message: "User role updated successfully",
          result,
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get("/admin/prompts", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await promptsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.json({ success: true, prompts: result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // 🎯 সব পেমেন্ট ডেটা অ্যাডমিনের জন্য নিয়ে আসার API
    app.get("/payments", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const payments = await paymentsCollection
          .find()
          .sort({ date: -1 })
          .toArray();

        res.json({
          success: true,
          data: payments,
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.put(
      "/admin/prompts/:id/approve",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          if (!ObjectId.isValid(id))
            return res
              .status(400)
              .json({ success: false, message: "Invalid ID" });
          const result = await promptsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "approved" } },
          );
          res.json({
            success: true,
            message: "Prompt approved successfully",
            result,
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    app.put(
      "/admin/prompts/:id/reject",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { feedback } = req.body;
          if (!ObjectId.isValid(id))
            return res
              .status(400)
              .json({ success: false, message: "Invalid ID" });
          const result = await promptsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: "Rejected", feedback: feedback || "" } },
          );
          res.json({
            success: true,
            message: "Prompt rejected successfully",
            result,
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    app.get(
      "/admin/reported-prompts",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const reportedPrompts = await reportsCollection
            .aggregate([
              { $match: { promptId: { $type: "objectId" } } },
              {
                $lookup: {
                  from: "prompts",
                  localField: "promptId",
                  foreignField: "_id",
                  as: "promptDetails",
                },
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
                  createdAt: 1,
                },
              },
            ])
            .toArray();
          res.json({ success: true, data: reportedPrompts });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    app.delete(
      "/admin/users/:identifier",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { identifier } = req.params;
          let query = identifier.includes("@")
            ? { email: identifier }
            : { _id: new ObjectId(identifier) };

          if (req.user.sub === identifier || req.user.email === identifier) {
            return res.status(400).json({
              success: false,
              message: "You cannot delete your own admin account!",
            });
          }

          const result = await usersCollection.deleteOne(query);
          if (result.deletedCount === 0)
            return res
              .status(404)
              .json({ success: false, message: "User not found" });

          res.json({ success: true, message: "User deleted successfully" });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    // For reported prmpt page
    // 1. REMOVE PROMPT
    app.delete(
      "/admin/reported-prompts/:reportId/remove-prompt",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { reportId } = req.params;

          if (!ObjectId.isValid(reportId)) {
            return res
              .status(400)
              .json({ success: false, message: "Invalid Report ID" });
          }

          // ১. প্রথমে রিপোর্ট টা খুঁজে বের করি যেন প্রম্পট আইডি পাই
          const report = await reportsCollection.findOne({
            _id: new ObjectId(reportId),
          });
          if (!report) {
            return res
              .status(404)
              .json({ success: false, message: "Report not found" });
          }

          // ২. মূল promptsCollection থেকে প্রম্পটটি ডিলিট করি
          await promptsCollection.deleteOne({
            _id: new ObjectId(report.promptId),
          });

          // ৩. এই রিপোর্টের স্ট্যাটাস 'resolved' করে দিই যেন পেন্ডিং লিস্টে না দেখায়
          await reportsCollection.updateOne(
            { _id: new ObjectId(reportId) },
            { $set: { status: "resolved", actionTaken: "removed_prompt" } },
          );

          res.json({
            success: true,
            message: "Prompt removed and report resolved successfully!",
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    // 2. WARN CREATOR
    app.patch(
      "/admin/reported-prompts/:reportId/warn-creator",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { reportId } = req.params;
          const { creatorEmail } = req.body; // ফ্রন্টএন্ড থেকে ক্রিয়েটরের ইমেইল পাঠানো হবে

          if (!ObjectId.isValid(reportId)) {
            return res
              .status(400)
              .json({ success: false, message: "Invalid Report ID" });
          }

          if (!creatorEmail) {
            return res.status(400).json({
              success: false,
              message: "Creator email is required to warn",
            });
          }

          // ১. ইউজার কালেকশনে ওই ক্রিয়েটরের warningsCount ১ বাড়িয়ে দিই
          await usersCollection.updateOne(
            { email: creatorEmail },
            { $inc: { warningsCount: 1 } }, // যদি ফিল্ড না থাকে, প্রথমবারে ১ হিসেবে তৈরি হবে
          );

          // ২. রিপোর্টের স্ট্যাটাস আপডেট করি
          await reportsCollection.updateOne(
            { _id: new ObjectId(reportId) },
            { $set: { status: "resolved", actionTaken: "warned_creator" } },
          );

          res.json({
            success: true,
            message: "Creator has been warned and report resolved.",
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    // 3. DISMISS / NOT HARMFUL
    app.patch(
      "/admin/reported-prompts/:reportId/dismiss",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { reportId } = req.params;

          if (!ObjectId.isValid(reportId)) {
            return res
              .status(400)
              .json({ success: false, message: "Invalid Report ID" });
          }

          // রিপোর্ট ডিলিট না করে স্ট্যাটাস 'dismissed' করে দেওয়া সবচেয়ে সেফ মেথড
          await reportsCollection.updateOne(
            { _id: new ObjectId(reportId) },
            { $set: { status: "dismissed" } },
          );

          res.json({
            success: true,
            message: "Report dismissed. Prompt is safe.",
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

    // Profile page dynamic API ───
    app.get("/user/profile", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user?.email;

        // ১. ইউজার কালেকশন থেকে ডাটাবেজ ইনফো আনা
        const userInfo = await usersCollection.findOne({ email: userEmail });

        // ২. ইউজার নিজে কয়টি প্রম্পট তৈরি করেছে তার কাউন্ট
        const promptCount = await promptsCollection.countDocuments({
          authorEmail: userEmail,
        });

        // রেসপন্স অবজেক্ট যা ফ্রন্টএন্ডের প্রোফাইল কার্ড সরাসরি রিড করতে পারবে
        return res.status(200).json({
          success: true,
          data: {
            name: userInfo?.name || req.user?.name || "Unknown User",
            email: userEmail,
            photoURL:
              userInfo?.image ||
              userInfo?.photoURL ||
              "https://placehold.co/200",
            role: userInfo?.role || req.user?.role || "User",
            totalPrompts: promptCount || 0,
            subscription: userInfo?.subscription || userInfo?.status || "Free", // Premium/Free status
          },
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    });

    // DONT TOUCH
    console.log("MongoDB connected successfully");
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
