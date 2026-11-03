/**
 * HTTP handlers for `/api/applications`.
 */
const { getPool } = require("../../db/pool");
const { handler, success } = require("../../core/http");
const { requireIdempotencyKey } = require("../../core/idempotency");
const { setRecoveryCookie } = require("../../core/cookies");
const { hasAdminKey } = require("../../middleware/apiKey");
const { validationFailed } = require("../../core/validation");
const workflowService = require("../../workflow/workflowService");
const sessionService = require("../session/sessionService");
const recoveryService = require("../session/recoveryService");
const service = require("./applicationService");

const LIST_STATUSES = ["IN_PROGRESS", "APPROVED", "REJECTED", "CANCELLED"];

/** Admin key or a session that belongs to this application. */
async function authoriseRead(req) {
  if (hasAdminKey(req)) return null;

  const session = await sessionService.requireSession(getPool(), req);
  sessionService.assertApplication(session, req.params.applicationId);
  return session;
}

const create = async (req, res) => {
  const { application, session, created } = await service.create({
    captchaToken: req.body?.captchaToken,
    ip: req.ip,
    idempotencyKey: requireIdempotencyKey(req),
  });
  const recovery = await recoveryService.issue({
    applicationId: application.id,
    actor: session.actor,
  });
  setRecoveryCookie(res, recovery.token, recovery.expiresAt);

  return success(
    res,
    {
      idempotentReplay: !created,
      session: {
        token: session.sessionId,
        header: sessionService.SESSION_HEADER,
        actor: session.actor,
        expiresAt: session.expiresAt,
      },
      ...workflowService.mutationView(application, {
        actor: "BORROWER",
        canSubmitActor: "BORROWER",
      }),
    },
    created ? 201 : 200
  );
};

const list = async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  const offset = Number(req.query.offset ?? 0);

  if (!Number.isInteger(limit) || limit < 1) {
    throw validationFailed("'limit' must be a positive integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw validationFailed("'offset' must be zero or greater");
  }

  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  if (status && !LIST_STATUSES.includes(status)) {
    throw validationFailed(`'status' must be one of: ${LIST_STATUSES.join(", ")}`);
  }

  return success(res, await service.list({ limit, offset, status }));
};

const detail = async (req, res) => {
  await authoriseRead(req);
  return success(res, await service.detail(req.params.applicationId));
};

const events = async (req, res) => {
  const session = await authoriseRead(req);
  return success(res, await workflowService.getEvents(req.params.applicationId, session));
};

module.exports = {
  create: handler(create),
  list: handler(list),
  detail: handler(detail),
  events: handler(events),
};
