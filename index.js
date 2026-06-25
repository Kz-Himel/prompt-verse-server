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

    // ভাই, এখানে একটা সিঙ্গেল ডাটাবেজ ভ্যারিয়েবল ডিক্লেয়ার করলাম
    // আপনার .env ফাইলের AUTH_DB_NAME ই হবে মেইন ডাটাবেজ
    const dbName = process.env.AUTH_DB_NAME || "PromptVerse";
    const db = client.db(dbName);

    // এখন এই একটা ডাটাবেজের ভেতরেই ২টা কালেকশন (টেবিল) তৈরি হবে
    const usersCollection = db.collection("users");
    const promptsCollection = db.collection("prompts");

    // ─── ১. প্রম্পট সেভ করার API ───
    app.post("/prompts", async (req, res) => {
      try {
        const prompt = req.body;
        const { authorEmail, authorRole } = prompt;

        if (!authorEmail) {
          return res
            .status(400)
            .send({ success: false, message: "User email is required" });
        }

        if (authorRole === "user") {
          const count = await promptsCollection.countDocuments({ authorEmail });
          if (count >= 3) {
            return res.status(403).send({
              success: false,
              message:
                "Prompt limit reached for free users. Please upgrade to Creator.",
            });
          }
        }

        const result = await promptsCollection.insertOne(prompt);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Failed to save prompt" });
      }
    });

    // ─── ২. প্রম্পট কাউন্ট নেওয়ার API ───
    app.get("/prompts/count/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const count = await promptsCollection.countDocuments({
          authorEmail: email,
        });
        res.send({ count });
      } catch (error) {
        res.status(500).send({ message: "Failed to get prompt count" });
      }
    });

    // ─── ৩. ডাটাবেজ থেকে সব প্রম্পট গেট (GET) করার API ───
    app.get("/prompts", async (req, res) => {
      try {
        // ডাটাবেজ থেকে সব প্রম্পট উল্টো ক্রমানুসারে (নতুনগুলো আগে) নিয়ে আসা
        // আপনি যদি চান শুধু এডমিন অ্যাপ্রুভড প্রম্পট দেখাবেন, তবে এখানে { status: "approved" } দিতে পারেন
        const prompts = await promptsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.send({
          success: true,
          data: prompts,
        });
      } catch (error) {
        console.error("Error fetching prompts:", error);
        res.status(500).send({
          success: false,
          message: "Failed to fetch prompts",
        });
      }
    });

    // Prompt Details
    app.get("/prompts/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.query.email; // কুয়েরি প্যারাম থেকে ইউজারের ইমেইল

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ success: false, message: "Invalid Prompt ID" });
        }

        const prompt = await promptsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!prompt) {
          return res
            .status(404)
            .send({ success: false, message: "Prompt not found" });
        }

        // ইউজার প্রিমিয়াম কিনা চেক করা (ডাটাবেজ থেকে)
        let isPremiumUser = false;
        if (userEmail) {
          const user = await usersCollection.findOne({ email: userEmail });
          if (user && user.status === "Premium") {
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
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    });


    // ─── ২. বুকমার্ক টগল API (POST) ───
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

    // don't touch
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
