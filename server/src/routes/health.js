const express = require("express");

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "linkedin-visit-logger-server",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
