const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const dbName = process.env.AUTH_DB_NAME || "PromptVerse";
    const db = client.db(dbName);

    // কালেকশন ডিক্লেয়ারেশন (সবগুলো এক জায়গায় ডিফাইন করা হয়েছে)
    const usersCollection = db.collection("users");
    const promptsCollection = db.collection("prompts");
    const bookmarksCollection = db.collection("bookmarks");
    const reportsCollection = db.collection("reports");

    // ─── ১. প্রম্পট সেভ করার API ───
    app.post("/prompts", async (req, res) => {
      try {
        const prompt = req.body;
        const { authorEmail, authorRole } = prompt;

        if (!authorEmail) {
          return res.status(400).send({ success: false, message: "User email is required" });
        }

        if (authorRole === "user") {
          const count = await promptsCollection.countDocuments({ authorEmail });
          if (count >= 3) {
            return res.status(403).send({
              success: false,
              message: "Prompt limit reached for free users. Please upgrade to Creator.",
            });
          }
        }

        const result = await promptsCollection.insertOne({
          ...prompt,
          copyCount: 0,
          reviews: [],
          createdAt: new Date()
        });
        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to save prompt" });
      }
    });

    // ─── ২. প্রম্পট কাউন্ট নেওয়ার API ───
    app.get("/prompts/count/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const count = await promptsCollection.countDocuments({ authorEmail: email });
        res.send({ count });
      } catch (error) {
        res.status(500).send({ message: "Failed to get prompt count" });
      }
    });

    // ─── ৩. ডাটাবেজ থেকে সব প্রম্পট গেট (GET) করার API ───
    app.get("/prompts", async (req, res) => {
      try {
        const prompts = await promptsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.send({ success: true, data: prompts });
      } catch (error) {
        console.error("Error fetching prompts:", error);
        res.status(500).send({ success: false, message: "Failed to fetch prompts" });
      }
    });

    // ─── ৪. একক প্রম্পট ডিটেইলস ও প্রিমিয়াম স্ট্যাটাস গেট (GET) ───
    app.get("/prompts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.query.email;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ success: false, message: "Invalid Prompt ID" });
        }

        // ফিক্সড: সিনট্যাক্স এরর ঠিক করা হয়েছে [new ObjectId(id)]
        const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
        if (!prompt) {
          return res.status(404).send({ success: false, message: "Prompt not found" });
        }

        // সেফটি চেক: ডাটাবেজে ফিল্ড না থাকলে ক্র্যাশ এড়ানোর ব্যবস্থা
        if (!prompt.reviews) prompt.reviews = [];
        if (!prompt.copyCount) prompt.copyCount = 0;

        // ইউজার প্রিমিয়াম বা অ্যাডমিন কিনা চেক
        let isPremiumUser = false;
        if (userEmail) {
          const user = await usersCollection.findOne({ email: userEmail });
          if (user && (user.status === "Premium" || user.role === "creator" || user.role === "admin")) {
            isPremiumUser = true;
          }
        }

        // বুকমার্ক স্ট্যাটাস চেক
        let bookmarked = false;
        if (userEmail) {
          const bookmarkExists = await bookmarksCollection.findOne({
            userEmail,
            promptId: id,
          });
          if (bookmarkExists) bookmarked = true;
        }

        res.send({
          success: true,
          data: prompt,
          isPremiumUser,
          isBookmarked: bookmarked,
        });
      } catch (error) {
        console.error("Error in GET /prompts/:id ->", error);
        res.status(500).send({ success: false, message: "Internal Server Error", error: error.message });
      }
    });

    // ─── ৫. বুকমার্ক টগল API (POST) ───
    app.post("/prompts/:id/bookmark", async (req, res) => {
      try {
        const promptId = req.params.id;
        const { email } = req.body;

        if (!email) return res.status(400).send({ message: "User email required" });

        const query = { userEmail: email, promptId: promptId };
        const existingBookmark = await bookmarksCollection.findOne(query);

        if (existingBookmark) {
          await bookmarksCollection.deleteOne(query);
          return res.send({ success: true, bookmarked: false, message: "Bookmark removed" });
        } else {
          await bookmarksCollection.insertOne({ ...query, createdAt: new Date() });
          return res.send({ success: true, bookmarked: true, message: "Prompt bookmarked" });
        }
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // ─── ৬. কপি কাউন্ট বাড়ানোর API (PATCH) ───
    app.patch("/prompts/:id/copy", async (req, res) => {
      try {
        const id = req.params.id;
        await promptsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $inc: { copyCount: 1 } }
        );
        res.send({ success: true, message: "Copy count incremented" });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // ─── ৭. রিভিউ ও রেটিং অ্যাড করার API (POST) ───
    app.post("/prompts/:id/reviews", async (req, res) => {
      try {
        const promptId = req.params.id;
        const { name, email, rating, comment } = req.body;

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

        res.send({ success: true, message: "Review added", review: newReview });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // ─── ৮. রিপোর্ট সাবমিট করার API (POST) ───
    app.post("/prompts/:id/report", async (req, res) => {
      try {
        const promptId = req.params.id;
        const { userEmail, reason, description } = req.body;

        const reportData = {
          promptId: new ObjectId(promptId),
          userEmail,
          reason,
          description,
          status: "pending",
          createdAt: new Date(),
        };

        await reportsCollection.insertOne(reportData);
        res.send({ success: true, message: "Report submitted successfully" });
      } catch (error) {
        res.status(500).send({ message: error.message });
      }
    });

    // Connection Ping
    await client.db("admin").command({ ping: 1 });
    console.log(`MongoDB connected successfully to database: ${dbName}`);
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});