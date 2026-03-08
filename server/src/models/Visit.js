const mongoose = require("mongoose");

const visitSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ExtensionSession",
      required: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: false,
      trim: true,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    endedAt: {
      type: Date,
      required: true,
    },
    durationMs: {
      type: Number,
      required: true,
      min: 0,
    },
    actions: {
      type: [String],
      default: [],
    },
    scrollCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxScrollY: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

visitSchema.index({ url: 1, startedAt: -1 });

module.exports = mongoose.model("Visit", visitSchema);
