/**
 * HTTP handlers for the recovery flow.
 *
 * Mounted twice: under `/api/workflow/recovery` for the canonical API and at
 * `/workflow/recovery` for the browser contract. The handlers are identical, so
 * there is one implementation rather than two routes that could drift.
 *
 * No handler trusts a client-supplied actor, verification flag or phone number:
 * the actor comes from the challenge row, and the only input accepted here is
 * an identifier plus evidence that is checked server-side.
 */
const express = require("express");
const { rateLimit } = require("../../middleware/security");
const { handler, success } = require("../../core/http");
const { setRecoveryCookie } = require("../../core/cookies");
const sessionRecovery = require("../session/recoveryService");
const recoveryService = require("./recoveryService");

const start = async (req, res) => {
  const result = await recoveryService.start({
    workflowId: req.body?.workflowId,
    actor: req.body?.actor,
    captchaToken: req.body?.captchaToken ?? req.get("x-captcha-token"),
    ip: req.ip,
  });

  return success(res, result, 201);
};

const requestOtp = async (req, res) => {
  const result = await recoveryService.requestOtp({ recoveryId: req.body?.recoveryId });
  return success(res, result, 201);
};

const verifyOtp = async (req, res) => {
  const result = await recoveryService.verifyOtp({
    recoveryId: req.body?.recoveryId,
    code: req.body?.code ?? req.body?.otp,
  });

  return success(res, result);
};

const complete = async (req, res) => {
  const { application, session, state } = await recoveryService.complete({
    recoveryId: req.body?.recoveryId,
  });

  // Recovery just proved ownership, so leave the browser the same durable
  // credential a normal session start would have: the next reload can then
  // resume silently instead of starting this flow again.
  const credential = await sessionRecovery.issue({
    applicationId: application.id,
    actor: session.actor,
  });
  setRecoveryCookie(res, credential.token, credential.expiresAt);

  return success(res, {
    status: "OK",
    workflowId: application.workflow_id,
    sessionId: session.sessionId,
    actor: session.actor,
    expiresAt: session.expiresAt,
    // The engine decides the node; the client only receives it.
    workflow: state,
  });
};

const router = express.Router();

// `start` is the expensive one: it touches the database, the captcha provider
// and mints a challenge. Per-application limits live in recoveryService.
router.post(
  "/start",
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, name: "recovery-start" }),
  handler(start)
);

router.post(
  "/otp/request",
  rateLimit({ windowMs: 10 * 60 * 1000, max: 10, name: "recovery-otp-request" }),
  handler(requestOtp)
);

router.post(
  "/otp/verify",
  rateLimit({ windowMs: 5 * 60 * 1000, max: 30, name: "recovery-otp-verify" }),
  handler(verifyOtp)
);

router.post(
  "/complete",
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, name: "recovery-complete" }),
  handler(complete)
);

module.exports = {
  router,
  start: handler(start),
  requestOtp: handler(requestOtp),
  verifyOtp: handler(verifyOtp),
  complete: handler(complete),
};
