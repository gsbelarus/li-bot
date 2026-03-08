const express = require("express");
const Visit = require("../models/Visit");
const ExtensionSession = require("../models/ExtensionSession");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const {
      sessionId,
      url,
      title,
      startedAt,
      endedAt,
      durationMs,
      actions,
      postVisits,
      scrollCount,
      maxScrollY,
    } = req.body;

    if (!sessionId || !url || !startedAt || !endedAt || typeof durationMs !== "number") {
      return res.status(400).json({
        error: "sessionId, url, startedAt, endedAt, and durationMs are required.",
      });
    }

    const session = await ExtensionSession.findById(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const visit = await Visit.create({
      sessionId,
      url,
      title,
      startedAt: new Date(startedAt),
      endedAt: new Date(endedAt),
      durationMs,
      actions: Array.isArray(actions) ? actions : [],
      postVisits: Array.isArray(postVisits)
        ? postVisits
            .filter((postVisit) => postVisit && postVisit.clickedAt)
            .map((postVisit) => ({
              url: typeof postVisit.url === "string" ? postVisit.url : undefined,
              postUrn: typeof postVisit.postUrn === "string" ? postVisit.postUrn : undefined,
              textPreview:
                typeof postVisit.textPreview === "string" ? postVisit.textPreview : undefined,
              clickedAt: new Date(postVisit.clickedAt),
            }))
        : [],
      scrollCount: Number(scrollCount || 0),
      maxScrollY: Number(maxScrollY || 0),
    });

    return res.status(201).json(visit);
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    const visits = await Visit.find().sort({ startedAt: -1 }).limit(100);
    res.json(visits);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
