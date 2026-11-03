/**
 * HTTP handlers for the workflow endpoints.
 *
 * The actor always comes from the session; the body only carries the node and
 * its payload.
 */
const { getPool } = require("../../db/pool");
const { handler, success } = require("../../core/http");
const { requireEventId, requireIdempotencyKey } = require("../../core/idempotency");
const { validationFailed } = require("../../core/validation");
const workflowService = require("../../workflow/workflowService");
const sessionService = require("../session/sessionService");

const state = async (req, res) => {
  const session = await sessionService.requireSession(getPool(), req);
  return success(res, await workflowService.getState(session.applicationId, session));
};

const submit = async (req, res) => {
  const session = await sessionService.requireSession(getPool(), req);

  const nodeKey = req.body?.node;
  if (typeof nodeKey !== "string" || nodeKey.trim() === "") {
    throw validationFailed("'node' is required");
  }

  const eventId = requireEventId(req, req.body?.eventId);

  return success(
    res,
    await workflowService.submitStep({
      applicationId: session.applicationId,
      nodeKey: nodeKey.trim(),
      data: req.body?.data,
      session,
      ip: req.ip,
      captchaToken: req.body?.captchaToken ?? req.get("x-captcha-token"),
      eventId,
    })
  );
};

/** Node metadata (component, access rules, outgoing edges). */
const describeStep = async (req, res) => {
  return success(res, workflowService.describeStep(req.params.nodeKey));
};

/** Trusted-service completion of a SYSTEM node. */
const completeInternal = async (req, res) => {
  return success(res, await workflowService.completeInternalStep({
    applicationId: req.params.applicationId,
    nodeKey: req.params.nodeKey,
    data: req.body?.data ?? req.body,
    eventId: requireIdempotencyKey(req),
  }));
};

module.exports = {
  state: handler(state),
  submit: handler(submit),
  describeStep: handler(describeStep),
  completeInternal: handler(completeInternal),
};
