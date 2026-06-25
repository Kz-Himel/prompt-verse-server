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

    const db = client.db(process.env.AUTH_DB_NAME);
    const usersCollection = db.collection("users");
    const promptsCollection = db.collection("prompts");


    app.post("/prompts", async (req, res) => {
        const prompt = req.body;
        const result = await promptsCollection.insertOne(prompt);
        res.send(result);
    })


    // dont touch
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected successfully");

    // Routes here
  } finally {
    // keep connection alive
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});