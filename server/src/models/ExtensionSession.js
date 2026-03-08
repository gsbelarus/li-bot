const mongoose = require("mongoose");

const extensionSessionSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      default: "chrome-extension",
      trim: true,
    },
    tabId: {
      type: Number,
      required: false,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    endedAt: {
      type: Date,
      required: false,
    },
    status: {
      type: String,
      enum: ["active", "stopped"],
      default: "active",
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ExtensionSession", extensionSessionSchema);
