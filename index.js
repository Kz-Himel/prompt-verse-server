const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

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
    const dbName = process.env.AUTH_DB_NAME || "PromptVerse"
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
          return res.status(400).send({ success: false, message: "User email is required" });
        }

        if (authorRole === "user") {
          const count = await promptsCollection.countDocuments({ authorEmail });
          if (count >= 3) {
            return res.status(403).send({ 
              success: false, 
              message: "Prompt limit reached for free users. Please upgrade to Creator." 
            });
          }
        }

        const result = await promptsCollection.insertOne(prompt);
        res.send({ success: true, insertedId: result.insertedId });
      } catch (error) {
        res.status(500).send({ success: false, message: "Failed to save prompt" });
      }
    });

    // ─── ২. প্রম্পট কাউন্ট নেওয়ার API ───
    app.get("/prompts/count/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const count = await promptsCollection.countDocuments({ authorEmail: email });
        res.send({ count });
      } catch (error) {
        res.status(500).send({ message: "Failed to get prompt count" });
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