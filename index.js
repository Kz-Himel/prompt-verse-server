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

// CORS
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

    // Better-Auth email check by role
    req.user = {
      email: payload.email || payload.user?.email || payload.sub,
      role: payload.role || "user",
      name: payload.name || payload.user?.name,
    };

    // console.log("👉 Dashboard API Hit By User:", req.user.email);
    next();
  } catch (err) {
    // console.error("JWT ERROR:", err);
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

    // 1. Prompt post API (SECURED) ───
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
          visibility: prompt.visibility || "public", //visibilty
          createdAt: new Date(),
        };

        const result = await promptsCollection.insertOne(newPrompt);
        res.json({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // 2. GET all prompts API (WITH BLUR/LOCK LOGIC FOR PRIVATE PROMPTS) ───
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
          email,
        } = req.query;

        // just show approved prompt
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

        // 1.check puser premium or not
        let isPremiumUser = false;
        if (email && email !== "undefined" && email !== "") {
          const user = await usersCollection.findOne({ email });
          // if user free user he cant see other premium prompts excepts his owns
          if (user && (user.status === "Premium" || user.role === "admin")) {
            isPremiumUser = true;
          }
        }

        // 2. processed genaret data
        const processedPrompts = prompts.map((prompt) => {
          let updatedPrompt = { ...prompt };

          const originalContent = prompt.promptContent || prompt.content || "";

          // check is user really the creator of this prompt
          const isAuthor = email && prompt.authorEmail === email;

          //
          if (prompt.visibility === "private" && !isPremiumUser && !isAuthor) {
            updatedPrompt.content = "LOCKED_PREMIUM";
            updatedPrompt.promptContent = "LOCKED_PREMIUM";
          } else {
            //
            updatedPrompt.content = originalContent;
            updatedPrompt.promptContent = originalContent;
          }

          return updatedPrompt;
        });

        // chcek precsedd prompt is premium
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

    // USER DASHBOARD STATS
    app.get("/user/dashboard-stats", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user?.email;

        // prompt count
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
            promptCount: promptCount || 0,
          },
        });
      } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
      }
    });

    // Chek user premium or not for prompts post
    app.post("/user/prompts", verifyToken, async (req, res) => {
      try {
        const userId = req.user.id;
        const userRole = req.user.role;

        // 1. check is user premium
        if (userRole !== "premium") {
          const promptCount = await promptsCollection.countDocuments({
            userId: userId,
          });

          if (promptCount >= 3) {
            return res.status(403).json({
              success: false,
              message:
                "Limit reached! Free users can only add up to 3 prompts. Please upgrade to premium.",
            });
          }
        }

        // 2.if premium or less than 3
        const newPrompt = req.body;
        const result = await promptsCollection.insertOne({
          ...newPrompt,
          userId,
          createdAt: new Date(),
        });

        res.json({
          success: true,
          message: "Prompt created successfully!",
          result,
        });
      } catch (error) {
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // Current users review that he give others prompt
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
                aiTool: 1, // Prompt er AI Tool (: ChatGPT, Midjourney)
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

    // Creator Dashboard Analytics
    app.get("/creator/analytics", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;

        // 1. (Total Prompts, Total Copies)
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

        // 2. Bookmark count
        const totalBookmarks = await bookmarksCollection.countDocuments({
          authorEmail: userEmail,
        });

        const stats = statsAggregation[0]
          ? {
              totalPrompts: statsAggregation[0].totalPrompts,
              totalCopies: statsAggregation[0].totalCopies || 0,
              totalBookmarks: totalBookmarks,
            }
          : { totalPrompts: 0, totalCopies: 0, totalBookmarks: 0 };

        // 3. Chart Data Total Copies & Prompt Growth
        const chartDataAggregation = await promptsCollection
          .aggregate([
            { $match: { authorEmail: userEmail } },
            {
              $group: {
                //  Jan, Feb, Mar)
                _id: { $dateToString: { format: "%b", date: "$createdAt" } },
                copies: { $sum: "$copyCount" }, // Total Copies
                promptCount: { $sum: 1 }, // Prompt Growth
              },
            },
            {
              $project: {
                name: "$_id",
                copies: 1,
                prompts: "$promptCount", // Recharts
                _id: 0,
              },
            },
            // set according to month
            { $sort: { name: 1 } },
          ])
          .toArray();

        res.json({ success: true, stats, chartData: chartDataAggregation });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Single prompt details and premium lock
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

    // BookMark toggle API ───
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

    // Copy Count Increase API ───
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

    // Add Review and Rating API ───
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

    // Submit report API ───
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

    // Stripe payment intent API
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      try {
        const price = 500; // $5

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

    // Payment succes handler API
    app.post("/payments/success", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email;
        const { transactionId, amount } = req.body;

        // 1. Payment collection data insert
        await paymentsCollection.insertOne({
          transactionId,
          email: userEmail,
          amount,
          date: new Date(),
        });

        // 2. user collection status
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

    // Current User prompt list
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

    // Prompt Delete API ───
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

    // Current user bookmark list API
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

    // Top creator dynamic api
    app.get("/top-creators", async (req, res) => {
      try {
        const topCreators = await promptsCollection
          .aggregate([
            // 1. Filter approved prompts
            { $match: { status: "approved" } },
            // 2. Create group with creator email
            {
              $group: {
                _id: "$authorEmail",
                name: { $first: "$authorName" },
                role: { $first: "$authorRole" },
                totalPrompts: { $sum: 1 },
                totalCopies: { $sum: "$copyCount" },
                averageRating: {
                  $avg: { $ifNull: [{ $avg: "$reviews.rating" }, 5] },
                },
              },
            },
            // 3. Most copied prompts
            { $sort: { totalCopies: -1 } },
            // 4. Top 6 creators
            { $limit: 6 },
          ])
          .toArray();

        // Colors for badge
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
          const name = creator.name || creator._id.split("@")[0];
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

    // Users review dynamic API
    app.get("/customer-reviews", async (req, res) => {
      try {
        const reviewsData = await promptsCollection
          .aggregate([
            { $unwind: "$reviews" },
            { $sort: { "reviews.createdAt": -1 } },
            { $limit: 6 },
            {
              $project: {
                //
                name: {
                  $ifNull: [
                    "$reviews.reviewerName",
                    "$reviews.username",
                    "$reviews.name",
                    "$reviews.userEmail",
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

          if (reviewerName.includes("@")) {
            reviewerName = reviewerName.split("@")[0];
          }

          reviewerName =
            reviewerName.charAt(0).toUpperCase() + reviewerName.slice(1);

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

    app.patch(
      "/admin/prompts/:id/feature",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          if (!ObjectId.isValid(id))
            return res
              .status(400)
              .json({ success: false, message: "Invalid ID" });

          const prompt = await promptsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!prompt)
            return res
              .status(404)
              .json({ success: false, message: "Prompt not found" });

          const newFeaturedState = !prompt.featured;

          await promptsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { featured: newFeaturedState } },
          );

          res.json({
            success: true,
            featured: newFeaturedState,
            message: newFeaturedState
              ? "Prompt featured successfully!"
              : "Prompt unfeatured successfully!",
          });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
      },
    );

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

    // DELETE from all prompts
    app.delete(
      "/admin/prompts/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          const query = { _id: new ObjectId(id) };

          const result = await promptsCollection.deleteOne(query);

          if (result.deletedCount === 1) {
            res.json({
              success: true,
              message: "Prompt deleted successfully!",
            });
          } else {
            res
              .status(404)
              .json({ success: false, message: "Prompt not found!" });
          }
        } catch (error) {
          res.status(500).json({ success: false, message: error.message });
        }
      },
    );

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

          const report = await reportsCollection.findOne({
            _id: new ObjectId(reportId),
          });
          if (!report) {
            return res
              .status(404)
              .json({ success: false, message: "Report not found" });
          }

          await promptsCollection.deleteOne({
            _id: new ObjectId(report.promptId),
          });

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
          const { creatorEmail } = req.body;

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

          await usersCollection.updateOne(
            { email: creatorEmail },
            { $inc: { warningsCount: 1 } },
          );

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

    // CRITICAL: Placed at the bottom to avoid hijacking other specific routes due to optional param (:identifier?)
    app.delete(
      "/admin/users/:identifier",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const identifier = req.params.identifier || req.query.identifier;

          if (!identifier) {
            return res
              .status(400)
              .json({ success: false, message: "Identifier missing" });
          }

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

    // Profile page dynamic API ───
    app.get("/user/profile", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user?.email;

        // 1. Get data from usersCollection
        const userInfo = await usersCollection.findOne({ email: userEmail });

        // Usre prompt count
        const promptCount = await promptsCollection.countDocuments({
          authorEmail: userEmail,
        });

        // read Profile card
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
    // await client.db("admin").command({ ping: 1 });
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
