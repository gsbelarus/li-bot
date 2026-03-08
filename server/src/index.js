const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");
const config = require("./config");
const healthRoutes = require("./routes/health");
const sessionRoutes = require("./routes/sessions");
const visitRoutes = require("./routes/visits");

async function start() {
  await mongoose.connect(config.mongodbUri, {
    dbName: config.mongodbDb,
  });

  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(morgan("dev"));
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_req, res) => {
    res.json({
      ok: true,
      message: "LinkedIn visit logger API",
    });
  });

  app.use("/api/health", healthRoutes);
  app.use("/api/sessions", sessionRoutes);
  app.use("/api/visits", visitRoutes);

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({
      error: "Internal server error.",
      details: err.message,
    });
  });

  app.listen(config.port, () => {
    console.log(
      `Server listening on http://localhost:${config.port} using MongoDB database "${config.mongodbDb}".`
    );
  });
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
