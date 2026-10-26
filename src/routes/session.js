/**
 * session routes — mounted at /api/workflow/session
 *
 * POST /api/workflow/session
 *   Creates a workflow session. Anonymous sessions are fully valid — actor
 *   authentication is only demanded later by the Access Resolver when the
 *   resolved node requires it.
 *
 * GET /api/workflow/session/:sessionId
 *   Returns the current session state (status, expiry, and the active
 *   authentication block when an unexpired actor session exists).
 */

const express = require("express");
const sessionManager = require("../session/sessionManager");

const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const { workflowId, workflowActor, ttlMinutes } = req.body ?? {};
    const session = await sessionManager.createWorkflowSession({
      workflowId,
      workflowActor,
      ttlMinutes,
    });
    res.status(201).json(session);
  } catch (err) {
    next(err);
  }
});

router.get("/:sessionId", async (req, res, next) => {
  try {
    const session = await sessionManager.getSessionResponse(req.params.sessionId);
    if (!session) {
      return res.status(404).json({
        status: "SESSION_EXPIRED",
        sessionId: req.params.sessionId,
        message: "Session not found or expired",
      });
    }
    res.json(session);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
