/**
 * The complete public API surface.
 *
 * One canonical route per action — the legacy build exposed several duplicates
 * for the same operation, plus unauthenticated schema endpoints.
 */
const express = require("express");
const { rateLimit } = require("./middleware/security");
const { requireAdminKey, requireInternalToken } = require("./middleware/apiKey");
const { requireUuidParam } = require("./middleware/validateParams");
const { handler, success } = require("./core/http");
const { ping } = require("./db/pool");
const { config } = require("./config/env");
const captcha = require("./modules/captcha/captchaService");
const { definition } = require("./workflow/definition");

const applications = require("./modules/application/applicationController");
const workflow = require("./modules/workflow/workflowController");
const sessions = require("./modules/session/sessionController");
const auth = require("./modules/auth/authController");
const recovery = require("./modules/recovery/recoveryController");

const router = express.Router();

// ── Health ──────────────────────────────────────────────────────────────────
router.get(
  "/health",
  handler(async (req, res) => {
    const databaseOk = await ping();
    return success(
      res,
      {
        status: databaseOk ? "ok" : "degraded",
        database: databaseOk ? "up" : "down",
        workflowVersion: definition.workflowVersion,
        uptimeSeconds: Math.round(process.uptime()),
      },
      databaseOk ? 200 : 503
    );
  })
);

// ── reCAPTCHA ───────────────────────────────────────────────────────────────
// The site key is public by design; the secret key is never returned by any
// endpoint. A widget needs the key and the version, so this is the one place to
// fetch both.
router.get("/captcha/config", (req, res) =>
  success(res, {
    version: config.recaptcha.version,
    siteKey: config.recaptcha.siteKey,
    required: true,
    bypassed: captcha.isBypassed(),
  })
);

// ── Applications ────────────────────────────────────────────────────────────
router.post(
  "/applications",
  rateLimit({ windowMs: 60 * 60 * 1000, max: 20, name: "application-create" }),
  applications.create
);
router.get("/applications", requireAdminKey, applications.list);
router.get(
  "/applications/:applicationId",
  requireUuidParam("applicationId"),
  applications.detail
);
router.get(
  "/applications/:applicationId/events",
  requireUuidParam("applicationId"),
  applications.events
);

// ── Sessions ────────────────────────────────────────────────────────────────
router.post(
  "/sessions",
  requireAdminKey,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 30, name: "session-create" }),
  sessions.create
);

// ── Workflow ────────────────────────────────────────────────────────────────
router.get("/workflow/state", workflow.state);
router.post(
  "/workflow/events",
  rateLimit({ windowMs: 60 * 1000, max: 60, name: "workflow-submit" }),
  workflow.submit
);
router.get("/workflow/nodes", requireAdminKey, handler(async (req, res) => {
  return success(res, {
    workflowVersion: definition.workflowVersion,
    startState: definition.startState,
    nodes: Object.keys(definition.states),
  });
}));
router.get("/workflow/nodes/:nodeKey", requireAdminKey, workflow.describeStep);

// ── Session recovery ────────────────────────────────────────────────────────
// Also reachable at `/workflow/recovery` for the browser contract; both mounts
// use this one router so the two cannot diverge.
router.use("/workflow/recovery", recovery.router);

// ── Authentication challenges ───────────────────────────────────────────────
router.post(
  "/auth/challenges",
  rateLimit({ windowMs: 5 * 60 * 1000, max: 5, name: "auth-challenge" }),
  auth.start
);
router.post(
  "/auth/challenges/:challengeId/verify",
  rateLimit({ windowMs: 5 * 60 * 1000, max: 10, name: "auth-verify" }),
  auth.verify
);

// ── Internal (trusted services only) ────────────────────────────────────────
router.post(
  "/internal/workflow/applications/:applicationId/steps/:nodeKey",
  requireInternalToken,
  rateLimit({ windowMs: 60 * 1000, max: 300, name: "internal-step" }),
  requireUuidParam("applicationId"),
  workflow.completeInternal
);

module.exports = router;
