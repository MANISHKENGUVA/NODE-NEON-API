/**
 * The workflow engine.
 *
 * One application row, one `current_node`, one transaction per submitted step:
 *
 *   lock application → check sequence → check access → run the step handler
 *   → rebuild the rule-engine context → follow edges, running automatic
 *     system tasks inline → persist the new node → append audit events
 *
 * Actor steps stop at the next node that needs a person or an internal
 * service. System verdicts arrive through `completeInternalStep`, which runs
 * the same advance loop.
 */
const { withTransaction, getPool } = require("../db/pool");
const { rethrowDbError } = require("../core/dbErrors");
const { sha256 } = require("../core/hash");
const { conflict, forbidden, notFound, unprocessable } = require("../core/errors");
const {
  getActorForNode,
  isTerminal,
  getState: getNodeDefinition,
} = require("./definition");
const { buildWorkflowContext } = require("./contextBuilder");
const { resolveNextNode, presentForActor, describeNode } = require("./transitionResolver");
const { getNodeAccess, ACCESS_TYPES } = require("./accessPolicy");
const { getActorStep } = require("./stepRegistry");
const { getInternalStep, getAutoTask } = require("./systemSteps");
const applicationRepository = require("../modules/application/applicationRepository");
const sessionService = require("../modules/session/sessionService");
const { resolveApplicantForRole } = require("../modules/applicant/applicantService");
const captcha = require("../modules/captcha/captchaService");

const MAX_AUTO_STEPS = 20;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function requestHash(nodeKey, actor, data) {
  return sha256(JSON.stringify(canonicalize({ nodeKey, actor, data: data ?? {} })));
}

const TERMINAL_STATUS = Object.freeze({
  "BORROWER-STATUS-V1-APPROVED-V1": "APPROVED",
  "BORROWER-STATUS-V1-REJECTED-V1": "REJECTED",
  "COBORROWER-STATUS-V1-REJECTED-V1": "REJECTED",
  "BORROWER-STATUS-V1-CANCELLED-V1": "CANCELLED",
});

function toSummary(row) {
  return {
    id: row.id,
    applicationNo: row.application_no,
    workflowId: row.workflow_id,
    definitionVersion: row.definition_version,
    status: row.status,
    currentNode: row.current_node,
    currentActor: row.current_actor,
    requiresCoborrower: row.requires_coborrower,
    requestedAmount: row.requested_amount === null ? null : Number(row.requested_amount),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function nodeView(nodeKey, extra = {}) {
  if (!nodeKey) return null;
  return {
    ...describeNode(nodeKey),
    access: getNodeAccess(nodeKey),
    actor: getActorForNode(nodeKey),
    ...extra,
  };
}

async function buildContext(db, application) {
  const dataset = await applicationRepository.loadWorkflowDataset(db, application);
  return buildWorkflowContext(application, dataset);
}

/** Rejects any submission that does not match the node currently waiting. */
function assertCurrentNode(application, nodeKey) {
  if (application.status !== "IN_PROGRESS") {
    throw conflict("APPLICATION_CLOSED", `Application is already ${application.status}`);
  }
  if (application.current_node !== nodeKey) {
    throw conflict("STEP_OUT_OF_SEQUENCE", `The application is waiting at '${application.current_node}'`, {
      expectedNode: application.current_node,
    });
  }
}

async function appendEvents(db, applicationId, fromNode, events) {
  let sequence = await applicationRepository.nextEventSequence(db, applicationId);

  for (const event of events) {
    await applicationRepository.appendEvent(db, {
      applicationId,
      sequence,
      eventType: event.eventType,
      nodeKey: event.nodeKey,
      actor: event.actor,
      fromNode: fromNode ?? null,
      toNode: event.toNode ?? null,
      edgeId: event.edgeId ?? null,
      payload: event.payload ?? {},
      clientEventId: event.clientEventId ?? null,
      requestHash: event.requestHash ?? null,
    });
    sequence += 1;
  }
}

/**
 * Follows edges from the current node until a node is reached that nobody can
 * advance automatically.
 *
 * @returns {Promise<object>} the updated application row
 */
async function advance(
  db,
  staleApplication,
  { actor, submittedNode, summary, eventId = null, requestHash = null }
) {
  // The step handler just wrote rows; read the application again so the auto
  // tasks and the rule context see the same state the database does.
  let current = await applicationRepository.findById(db, staleApplication.id);
  const startNode = current.current_node;
  const events = [
    {
      eventType: "STEP_COMPLETED",
      nodeKey: submittedNode,
      actor,
      toNode: null,
      payload: summary ?? {},
      clientEventId: eventId,
      requestHash,
    },
  ];

  let target = null;
  let firstEdge = null;

  for (let step = 0; step < MAX_AUTO_STEPS; step += 1) {
    const context = await buildContext(db, current);
    const edge = resolveNextNode(current.current_node, context);

    if (!edge) {
      throw unprocessable(
        "NO_TRANSITION",
        `No rule matches from '${current.current_node}' with the submitted data`,
        { node: current.current_node }
      );
    }

    firstEdge = firstEdge ?? edge.edgeId;
    const autoTask = getAutoTask(edge.toState);

    if (!autoTask) {
      target = edge.toState;
      break;
    }

    const result = await autoTask({ db, application: current });
    events.push({
      eventType: "SYSTEM_STEP",
      nodeKey: edge.toState,
      actor: getActorForNode(edge.toState),
      toNode: edge.toState,
      edgeId: edge.edgeId,
      payload: result ?? {},
    });

    current = {
      ...current,
      current_node: edge.toState,
      current_actor: getActorForNode(edge.toState),
    };
    target = edge.toState;
  }

  if (!target) {
    throw unprocessable("WORKFLOW_LOOP", `Workflow did not settle from '${startNode}'`);
  }

  const status = TERMINAL_STATUS[target] ?? current.status;
  const updated = await applicationRepository.updateState(db, current.id, {
    currentNode: target,
    currentActor: getActorForNode(target),
    status,
    completedAt: isTerminal(target) ? new Date() : null,
  });

  events[0].toNode = target;
  events[0].edgeId = firstEdge;
  await appendEvents(db, current.id, startNode, events);

  return updated;
}

/** Shape returned by the mutating endpoints. */
function mutationView(
  application,
  { actor = null, canSubmitActor = null, duplicateEvent = false } = {}
) {
  const currentActor = getActorForNode(application.current_node);

  return {
    application: toSummary(application),
    node: nodeView(application.current_node),
    actorStatus: !actor || currentActor === actor ? "ACTIVE" : "WAITING",
    canSubmit: Boolean(
      canSubmitActor &&
        application.status === "IN_PROGRESS" &&
        currentActor === canSubmitActor &&
        getActorStep(application.current_node)
    ),
    duplicateEvent: Boolean(duplicateEvent),
  };
}

/** Completes the actor step waiting at `nodeKey`. */
async function submitStep({
  applicationId,
  nodeKey,
  data,
  session,
  ip,
  captchaToken,
  eventId = null,
}) {
  sessionService.assertApplication(session, applicationId);
  const hash = requestHash(nodeKey, session.actor, data);

  let outcome;
  try {
    outcome = await withTransaction(async (db) => {
      const application = await applicationRepository.lockById(db, applicationId);
      if (!application) throw notFound("Application not found");

      // A retry that carries the same client event id must be a no-op, not a
      // second step. This check runs after the row lock, so a concurrent
      // duplicate waits for the first transaction and then sees its event.
      if (eventId) {
        const existing = await applicationRepository.findEventByClientId(
          db,
          applicationId,
          eventId
        );
        if (existing) {
          if (existing.request_hash && existing.request_hash !== hash) {
            throw conflict(
              "IDEMPOTENCY_KEY_REUSED",
              "This event id was already used for a different request"
            );
          }
          return { application, duplicateEvent: true };
        }
      }

      assertCurrentNode(application, nodeKey);

      const access = getNodeAccess(nodeKey);
      const nodeActor = getActorForNode(nodeKey);
      const handler = getActorStep(nodeKey);

      if (!nodeActor) throw conflict("NODE_HAS_NO_ACTOR", `'${nodeKey}' is not an actor step`);
      if (!handler) {
        throw forbidden("Only an internal service can complete this step");
      }

      sessionService.assertActor(session, nodeActor);

      if (access.authentication.required) {
        await sessionService.assertAuthentication(
          db,
          session,
          access.authentication.methods ?? ["MOBILE_OTP", "AADHAAR"]
        );
      }

      await captcha.verify({
        token: captchaToken,
        remoteIp: ip,
        required: access.captcha.required,
      });

      const applicant = await resolveApplicantForRole(db, application, nodeActor);

      const summary = await handler({
        db,
        application,
        applicant,
        data: data ?? {},
        role: nodeActor,
        session,
        ip,
      });

      const updated = await advance(db, application, {
        actor: nodeActor,
        submittedNode: nodeKey,
        summary,
        eventId,
        requestHash: hash,
      });
      return { application: updated, duplicateEvent: false };
    });
  } catch (error) {
    rethrowDbError(error);
  }

  return mutationView(outcome.application, {
    actor: session.actor,
    canSubmitActor: session.actor,
    duplicateEvent: outcome.duplicateEvent,
  });
}

/** Records a system verdict and continues the flow. */
async function completeInternalStep({ applicationId, nodeKey, data, eventId = null }) {
  let outcome;
  try {
    outcome = await withTransaction(async (db) => {
      const application = await applicationRepository.lockById(db, applicationId);
      if (!application) throw notFound("Application not found");

      const actor = getActorForNode(nodeKey);
      const hash = requestHash(nodeKey, actor, data);
      if (eventId) {
        const existing = await applicationRepository.findEventByClientId(
          db,
          applicationId,
          eventId
        );
        if (existing) {
          if (existing.request_hash && existing.request_hash !== hash) {
            throw conflict(
              "IDEMPOTENCY_KEY_REUSED",
              "This event id was already used for a different request"
            );
          }
          return { application, duplicateEvent: true };
        }
      }

      assertCurrentNode(application, nodeKey);

      const internalStep = getInternalStep(nodeKey);
      if (!internalStep) {
        throw conflict("NOT_A_SYSTEM_STEP", `'${nodeKey}' is not completed by an internal service`);
      }
      if (getActorStep(nodeKey) && getNodeAccess(nodeKey).type !== ACCESS_TYPES.INTERNAL) {
        throw forbidden("This step belongs to an actor, not to an internal service");
      }

      const applicant = await resolveApplicantForRole(db, application, actor);
      const summary = await internalStep({ db, application, applicant, data: data ?? {} });

      const updated = await advance(db, application, {
        actor,
        submittedNode: nodeKey,
        summary,
        eventId,
        requestHash: hash,
      });
      return { application: updated, duplicateEvent: false };
    });
  } catch (error) {
    rethrowDbError(error);
  }

  return mutationView(outcome.application, { duplicateEvent: outcome.duplicateEvent });
}

/** Current workflow state as seen by the session's actor. */
async function getState(applicationId, session) {
  sessionService.assertApplication(session, applicationId);

  const db = getPool();
  const application = await applicationRepository.findById(db, applicationId);
  if (!application) throw notFound("Application not found");

  const history = await applicationRepository.loadHistory(db, applicationId);
  const presented = presentForActor({
    currentNode: application.current_node,
    actor: session.actor,
    history,
  });

  const access = getNodeAccess(presented.node);
  const isCurrent = presented.node === application.current_node;
  const authMethods = access.authentication.required
    ? access.authentication.methods ?? ["MOBILE_OTP", "AADHAAR"]
    : [];
  // The session-level flag is not enough: one method may have expired while
  // another is still valid, and a node can accept a specific subset.
  const authenticationSatisfied =
    authMethods.length === 0
      ? true
      : await sessionService.hasAnyAuthentication(db, session, authMethods);
  const authenticationExpired = Boolean(session.authenticationExpired);

  return {
    application: toSummary(application),
    node: nodeView(presented.node),
    actorStatus: presented.actorStatus,
    message: presented.message,
    canSubmit:
      isCurrent &&
      application.status === "IN_PROGRESS" &&
      presented.actorStatus === "ACTIVE" &&
      Boolean(getActorStep(presented.node)) &&
      access.type !== ACCESS_TYPES.INTERNAL,
    requiresAuthentication: isCurrent && access.authentication.required,
    requiresCaptcha: isCurrent && access.captcha.required,
    authentication: {
      required: access.authentication.required,
      methods: access.authentication.methods,
      satisfied: authenticationSatisfied,
      expired: authenticationExpired,
    },
    authenticationExpired,
    session: {
      actor: session.actor,
      // Effective status: an expired actor proof is not authenticated even
      // though the workflow session row still remembers that it once was.
      authenticated: session.status === "ACTOR_AUTHENTICATED",
      status: session.status,
      actorId: session.actorId,
    },
  };
}

/** Node metadata for a frontend that renders forms by component name. */
function describeStep(nodeKey) {
  const state = getNodeDefinition(nodeKey);
  if (!state) throw notFound(`Unknown node '${nodeKey}'`);

  return {
    ...nodeView(nodeKey),
    next: Object.entries(state.edges ?? {}).map(([edgeId, edge]) => ({
      edgeId,
      to: edge.toState,
      conditions: edge.ruleEngine?.conditions ?? [],
      type: edge.ruleEngine?.type ?? "AND",
    })),
  };
}

/** Audit trail for one application. */
async function getEvents(applicationId, session) {
  if (session) sessionService.assertApplication(session, applicationId);

  const db = getPool();
  const application = await applicationRepository.findById(db, applicationId);
  if (!application) throw notFound("Application not found");

  return {
    application: toSummary(application),
    events: await applicationRepository.listEvents(db, applicationId),
  };
}

module.exports = {
  TERMINAL_STATUS,
  toSummary,
  advance,
  mutationView,
  submitStep,
  completeInternalStep,
  getState,
  describeStep,
  getEvents,
};
