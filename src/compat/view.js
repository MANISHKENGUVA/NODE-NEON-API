/**
 * Vocabulary translation for the browser frontend.
 *
 * The engine keeps its own names (`application.currentNode`, `node.component`,
 * `actorStatus`, `canSubmit`). The frontend branches on `status`, `node`,
 * `component`, `workflowActor` and `access.type`. This module is the only place
 * that knows both, so the engine never has to learn frontend words and the
 * frontend never has to learn engine words.
 *
 * Precedence in `statusFor` is the contract the UI relies on:
 *
 *   closed application -> WORKFLOW_COMPLETED
 *   missing/unknown node or access -> ACCESS_DENIED (fail closed)
 *   internal node -> INTERNAL
 *   actor waiting for somebody else -> NOT_YOUR_TURN
 *   captcha gate -> CAPTCHA_REQUIRED
 *   authentication gate -> AUTHENTICATION_REQUIRED
 *   otherwise -> OK
 *
 * Only `OK` may render a form. Every other status is a gate or a terminal
 * state, which is why `canSubmit` is derived from `status` rather than from
 * the presence of a node alone.
 */

const STATUS = Object.freeze({
  OK: "OK",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  NOT_YOUR_TURN: "NOT_YOUR_TURN",
  INTERNAL: "INTERNAL",
  WORKFLOW_COMPLETED: "WORKFLOW_COMPLETED",
  ACCESS_DENIED: "ACCESS_DENIED",
});

const ACCESS_TYPES = Object.freeze(["PUBLIC", "ACTOR", "INTERNAL"]);

const DEFAULT_ACCESS = Object.freeze({
  type: "PUBLIC",
  captcha: { required: false },
  authentication: { required: false, methods: null },
});

/**
 * `access.type` as the frontend understands it.
 *
 * `PUBLIC_CAPTCHA` exists only in the frontend's vocabulary; the engine models
 * the same thing as a public node with `captcha.required`. An unknown access
 * type is reported as INTERNAL so a malformed definition cannot be promoted to
 * a public form.
 */
function accessType(access) {
  if (!access || !ACCESS_TYPES.includes(access.type)) return "INTERNAL";
  if (access.type === "INTERNAL") return "INTERNAL";
  if (access.type === "ACTOR") return "ACTOR";
  return access.captcha?.required ? "PUBLIC_CAPTCHA" : "PUBLIC";
}

function statusFor({
  application,
  access,
  nodeActor,
  session,
  actorStatus,
  authenticationSatisfied,
}) {
  if (application.status !== "IN_PROGRESS") return STATUS.WORKFLOW_COMPLETED;
  if (!access || !ACCESS_TYPES.includes(access.type)) return STATUS.ACCESS_DENIED;
  if (access.type === "INTERNAL") return STATUS.INTERNAL;

  // `presentForActor` tells us the actor is looking at their own last completed
  // node while somebody else is acting. That node must not render a form.
  if (actorStatus === "WAITING" || actorStatus === "NOT_YOUR_TURN") {
    return STATUS.NOT_YOUR_TURN;
  }
  if (nodeActor && nodeActor !== session.actor) return STATUS.NOT_YOUR_TURN;

  if (access.captcha?.required && !session.captchaVerifiedAt) {
    return STATUS.CAPTCHA_REQUIRED;
  }

  if (access.authentication?.required && authenticationSatisfied !== true) {
    return STATUS.AUTHENTICATION_REQUIRED;
  }

  return STATUS.OK;
}

/**
 * The authoritative "where is this user now?" payload.
 *
 * @param {object} input
 * @param {object} input.application application summary (camelCase)
 * @param {object|null} input.node    node view from the engine
 * @param {object} input.session      facts from `sessionService.resolveToken`
 * @param {object} [input.state]      `workflowService.getState` result, when available
 */
function toResolveView({ application, node, session, state }) {
  const access = node?.access ?? DEFAULT_ACCESS;
  const workflowActor = node?.actor ?? null;

  const actorStatus =
    state?.actorStatus ??
    (workflowActor && workflowActor !== session.actor ? "NOT_YOUR_TURN" : "ACTIVE");
  const authenticationSatisfied =
    state?.authentication?.satisfied ??
    (access.authentication?.required ? session.status === "ACTOR_AUTHENTICATED" : true);
  const authenticationExpired = Boolean(
    state?.authenticationExpired ||
      state?.authentication?.expired ||
      session.authenticationExpired
  );

  const status = statusFor({
    application,
    access,
    nodeActor: workflowActor,
    session,
    actorStatus,
    authenticationSatisfied,
  });

  const isOpen = application.status === "IN_PROGRESS";

  return {
    status,

    // What the router branches on.
    node: node?.node ?? null,
    component: node?.component ?? null,
    componentView: node?.componentView ?? null,
    workflowId: application.workflowId,
    workflowActor,

    // Context the pages display and pass along.
    applicationId: application.id,
    applicationNo: application.applicationNo,
    applicationStatus: application.status,
    access: { type: accessType(access) },
    captcha: access.captcha ?? null,
    authentication: {
      required: Boolean(access.authentication?.required),
      methods: access.authentication?.methods ?? null,
      satisfied: authenticationSatisfied,
      expired: authenticationExpired,
    },
    actorStatus,
    message: state?.message ?? null,
    sessionStatus: session.status,
    authenticationExpired,
    canSubmit:
      status === STATUS.OK &&
      isOpen &&
      Boolean(node) &&
      node.terminal !== true &&
      actorStatus === "ACTIVE" &&
      (!workflowActor || workflowActor === session.actor),
  };
}

/**
 * The legacy bootstrap shape, wrapped around the modern one so a client that
 * only understands `componentviewrender` still routes.
 */
function toLegacyView(view) {
  return {
    componentviewrender: {
      componentKey: view.componentView?.componentKey ?? null,
      component: view.component,
      module: view.componentView?.module ?? null,
      componentviewrenderState: view.node,
      workflowId: view.workflowId,
      workflowActor: view.workflowActor,
    },
    ...view,
  };
}

/**
 * The session handshake: an opaque `sessionId` plus the workflow it belongs to.
 *
 * `sessionId` is the same opaque string the canonical API calls a session
 * token; the frontend only ever echoes it.
 */
function toBootstrapView({ application, session }) {
  return {
    sessionId: session.sessionId,
    workflowId: application.workflowId,
    status: session.status === "ACTOR_AUTHENTICATED" ? "ACTOR_AUTHENTICATED" : "ANONYMOUS",
    actorId: session.actorId ?? "",
    expiresAt: session.expiresAt ?? null,
    authenticationExpired: Boolean(session.authenticationExpired),

    // Extras: ignored by the contract client, useful when debugging by hand.
    applicationId: application.id,
    applicationNo: application.applicationNo,
    node: application.currentNode,
    workflowActor: application.currentActor,
    sessionStatus: session.status,
  };
}

module.exports = {
  STATUS,
  ACCESS_TYPES,
  accessType,
  statusFor,
  toResolveView,
  toLegacyView,
  toBootstrapView,
};
