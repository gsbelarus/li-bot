const dotenv = require("dotenv");

dotenv.config();

const config = {
  port: Number(process.env.PORT || 3000),
  mongodbUri: process.env.MONGODB_URI,
  mongodbDb: process.env.MONGODB_DB || "linkedin",
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

if (!config.mongodbUri) {
  throw new Error("Missing MONGODB_URI in environment.");
}

module.exports = config;
