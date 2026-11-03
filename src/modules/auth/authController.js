/**
 * HTTP handlers for `/api/auth/challenges`.
 *
 * Only the session's own actor can be authenticated, so the actor is never read
 * from the body.
 */
const { getPool } = require("../../db/pool");
const { handler, success } = require("../../core/http");
const sessionService = require("../session/sessionService");
const authService = require("./authService");

const start = async (req, res) => {
  const session = await sessionService.requireSession(getPool(), req);

  const result = await authService.start({
    db: getPool(),
    session,
    method: req.body?.method,
    subject: req.body?.subject ?? req.body?.mobileNumber ?? req.body?.aadhaarNumber,
  });

  return success(res, result, 201);
};

const verify = async (req, res) => {
  const session = await sessionService.requireSession(getPool(), req);

  const result = await authService.verify({
    db: getPool(),
    session,
    challengeId: req.params.challengeId,
    code: req.body?.code,
  });

  return success(res, result);
};

module.exports = { start: handler(start), verify: handler(verify) };
