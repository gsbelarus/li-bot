const express = require("express");
const ExtensionSession = require("../models/ExtensionSession");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const session = await ExtensionSession.create({
      source: req.body.source || "chrome-extension",
      tabId: req.body.tabId,
      metadata: req.body.metadata || {},
    });

    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

router.patch("/:sessionId/stop", async (req, res, next) => {
  try {
    const session = await ExtensionSession.findByIdAndUpdate(
      req.params.sessionId,
      {
        status: "stopped",
        endedAt: req.body.endedAt ? new Date(req.body.endedAt) : new Date(),
      },
      {
        new: true,
      }
    );

    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    return res.json(session);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
