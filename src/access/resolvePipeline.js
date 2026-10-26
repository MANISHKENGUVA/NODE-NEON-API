/**
 * resolvePipeline.js
 *
 * The single implementation of the backend-authoritative resolution flow:
 *
 *   Request
 *     ↓
 *   Workflow Session (validate)
 *     ↓
 *   Get Latest Event (existing decideNextState)
 *     ↓
 *   Rule Engine (existing — unchanged)
 *     ↓
 *   Resolve Next Node (existing algorithm incl. actor fallback)
 *     ↓
 *   Access Resolver (this layer — PUBLIC / CAPTCHA / ACTOR / INTERNAL)
 *     ↓
 *   Response: node | CAPTCHA_REQUIRED | AUTHENTICATION_REQUIRED |
 *             ACCESS_DENIED | SESSION_EXPIRED | WORKFLOW_COMPLETED
 *
 * The Rule Engine NEVER decides access. The Access Resolver NEVER decides
 * the next node.
 */

const workflowDefinition = require("../FLOWDESIGNER/FLOWDESINGER.json");
const { decideNextState } = require("../services/workflowDecider");
const sessionManager = require("../session/sessionManager");
const { resolveNodeAccess } = require("./accessResolver");
const captchaService = require("../captcha/captchaService");

/**
 * Builds the response body for a non-OK access outcome. AUTHENTICATION_REQUIRED
 * deliberately does NOT include the protected node (the protected node must
 * not be returned as accessible).
 */
function buildDenialBody(outcome, { sessionId, workflowId, decision, accessDecision }) {
  const base = { sessionId };
  if (workflowId) base.workflowId = workflowId;

  switch (outcome) {
    case "CAPTCHA_REQUIRED":
      return {
        ...base,
        status: "CAPTCHA_REQUIRED",
        node: decision.node,
        component: decision.component,
        captcha: captchaService.describe(),
      };
    case "AUTHENTICATION_REQUIRED":
      return {
        ...base,
        status: "AUTHENTICATION_REQUIRED",
        authentication: accessDecision.authentication ?? { methods: [] },
      };
    case "ACCESS_DENIED":
    default:
      return { ...base, status: "ACCESS_DENIED" };
  }
}

/**
 * Full resolve pipeline used by POST /api/workflow/resolve and (when a
 * sessionId is supplied) POST /api/workflow/decider.
 *
 * @param   {object} input
 * @param   {string} input.sessionId
 * @param   {string} [input.workflowActor] — overrides the session's actor role
 * @param   {string} [input.captchaToken]
 * @param   {string} [input.internalToken]
 * @param   {string} [input.remoteIp]
 * @returns {Promise<{httpStatus: number, body: object}>}
 */
async function runResolvePipeline({
  sessionId,
  workflowActor,
  captchaToken,
  internalToken,
  remoteIp,
}) {
  if (!sessionId) {
    return {
      httpStatus: 400,
      body: { status: "ERROR", message: "sessionId is required" },
    };
  }

  // ── 1. Validate workflow session ─────────────────────────────────────────
  const loaded = await sessionManager.loadSession(sessionId);
  if (!loaded.ok) {
    return { httpStatus: 200, body: { status: loaded.status, sessionId } };
  }
  const session = loaded.session;

  // ── 2 + 3 + 4. Latest event → Rule Engine → next node (existing engine) ──
  const actor = workflowActor || session.workflow_actor || "BORROWER";
  const decision = await decideNextState({
    WORKFLOW_ID: session.workflow_id,
    WORKFLOW_ACTOR: actor,
  });

  const node = decision.componentviewrenderState;
  const stateDef = workflowDefinition.states[node];
  const component = stateDef?.component ?? null;

  const base = {
    sessionId,
    workflowId: session.workflow_id,
    node,
    component,
  };

  // ── Terminal state → workflow completed ──────────────────────────────────
  if (stateDef?.type === "TERMINAL") {
    return { httpStatus: 200, body: { status: "WORKFLOW_COMPLETED", ...base } };
  }

  // ── 5 + 6. Load node configuration and run the Access Resolver ───────────
  const accessDecision = await resolveNodeAccess({
    nodeKey: node,
    session,
    captchaToken,
    internalToken,
    remoteIp,
  });

  if (accessDecision.outcome !== "OK") {
    return {
      httpStatus: 200,
      body: buildDenialBody(accessDecision.outcome, {
        sessionId,
        workflowId: session.workflow_id,
        decision: base,
        accessDecision,
      }),
    };
  }

  // ── 7. Accessible → return the node ──────────────────────────────────────
  const access = { type: accessDecision.access.type };
  if (accessDecision.access.captcha?.required) {
    access.captcha = {
      required: true,
      ...(accessDecision.access.captcha.verified ? { verified: true } : {}),
    };
  }
  if (accessDecision.authentication) {
    access.authentication = {
      method: accessDecision.authentication.method,
      verifiedAt: accessDecision.authentication.verifiedAt,
      expiresAt: accessDecision.authentication.expiresAt,
    };
  }

  const body = { status: "OK", ...base, access };

  // Preserve the existing actor-turn statuses from the workflow engine.
  if (decision.status && decision.status !== "ACTIVE") {
    body.actorStatus = decision.status;
    if (decision.message) body.message = decision.message;
  }

  return { httpStatus: 200, body };
}

/**
 * Access guard for event submissions (POST /workflow/event and
 * POST /workflow/eventCreaterAndProcesser).
 *
 * When no sessionId is supplied the guard is skipped entirely — existing
 * clients keep their exact current behaviour.
 *
 * @param   {object} params
 * @param   {string} [params.sessionId]      — workflow session
 * @param   {string} [params.node]           — completed step being submitted
 * @param   {string} [params.captchaToken]
 * @param   {string} [params.internalToken]
 * @param   {string} [params.remoteIp]
 * @returns {Promise<{ok: boolean, session?: object, httpStatus?: number, body?: object}>}
 */
async function runEventAccessGuard({ sessionId, node, captchaToken, internalToken, remoteIp }) {
  if (!sessionId) {
    return { ok: true, session: null }; // legacy path — no session supplied
  }

  const loaded = await sessionManager.loadSession(sessionId);
  if (!loaded.ok) {
    return { ok: false, body: { status: loaded.status, sessionId } };
  }

  // The node being completed must be a real node in the flow definition —
  // unknown nodes are rejected instead of defaulting to PUBLIC.
  if (!workflowDefinition.states[node]) {
    return {
      ok: false,
      httpStatus: 400,
      body: {
        status: "ERROR",
        message: `Step '${node}' is not a valid state in the flow definition.`,
      },
    };
  }

  const accessDecision = await resolveNodeAccess({
    nodeKey: node,
    session: loaded.session,
    captchaToken,
    internalToken,
    remoteIp,
  });

  if (accessDecision.outcome !== "OK") {
    return {
      ok: false,
      body: buildDenialBody(accessDecision.outcome, {
        sessionId,
        workflowId: loaded.session.workflow_id,
        decision: { node, component: workflowDefinition.states[node].component ?? null },
        accessDecision,
      }),
    };
  }

  return { ok: true, session: loaded.session };
}

module.exports = {
  runResolvePipeline,
  runEventAccessGuard,
};

