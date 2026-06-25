const express = require("express");
const app = express();
const port = process.env.PORT

app.get("/", (req, res) => {
    res.send("Server is running...");
})

app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
})