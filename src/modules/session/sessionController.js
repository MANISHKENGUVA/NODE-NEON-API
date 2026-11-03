/**
 * HTTP handlers for `/api/sessions`.
 *
 * A session binds a client to one application and one actor. This operator
 * endpoint requires the admin API key; borrower sessions are issued during
 * application creation or verified recovery.
 */
const { getPool } = require("../../db/pool");
const { handler, success } = require("../../core/http");
const { hasAdminKey } = require("../../middleware/apiKey");
const { UUID } = require("../../middleware/validateParams");
const { requireMatch, requireString } = require("../../core/validation");
const sessionService = require("./sessionService");

const create = async (req, res) => {
  const applicationId = requireMatch(
    req.body?.applicationId,
    "applicationId",
    UUID,
    "'applicationId' must be an application id"
  );
  const actor = requireString(req.body?.actor, "actor", { max: 20 }).toUpperCase();

  const session = await sessionService.issue(getPool(), {
    applicationId,
    actor,
    isAdmin: hasAdminKey(req),
  });

  return success(
    res,
    {
      token: session.sessionId,
      header: sessionService.SESSION_HEADER,
      actor: session.actor,
      expiresAt: session.expiresAt,
    },
    201
  );
};

module.exports = { create: handler(create) };
