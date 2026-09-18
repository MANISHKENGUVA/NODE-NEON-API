

/**
 * workflowDecider.js
 *
 * Decision pipeline:
 *
 *   1. Fetch the workflow row from DB
 *   2. Get the latest loan event (currentState or last entry in states[])
 *   3. Evaluate the Rule Engine on that event → first matching edge wins
 *   4. If NO edge matches → 422 error (terminal / unresolved)
 *   5. If an edge matches → resolve the target node
 *        a. Target node belongs to the requesting actor → return it
 *        b. Target node belongs to a different actor   → fall back to the
 *           actor's own latest event and return that node
 *           (no second Rule Engine pass on the loan — only on the actor's event)
 *
 * SOLID notes:
 *   S — every function has a single, named responsibility
 *   O — the pipeline steps are composed, not tangled; add new steps without
 *       touching existing ones
 *   L — all helpers have stable contracts; callers are not surprised
 *   I — each layer imports only what it uses
 *   D — external dependencies (sql, ruleEngine, eventPublisher, …) are
 *       resolved at module load time, not buried inside logic functions
 */

// ─── External dependencies ────────────────────────────────────────────────────
const workflowDefinition  = require("../FLOWDESIGNER/FLOWDESINGER.json");
const { evaluateRuleEngine } = require("./ruleEngine");
const { sql }               = require("../config/db");
const { setContextKey }     = require("../context");
const eventPublisher        = require("./eventPublisher");
const { buildWorkflowContext } = require("./domainDatastore");


// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — Pure helpers  (no I/O, no side-effects)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Splits a composite state key into its module and component parts.
 *
 * "BORROWER-DETAILS-V1-PERSONAL-INFO-V1"
 *   → { module: "BORROWER-DETAILS-V1", componentKey: "PERSONAL-INFO-V1" }
 *
 * Falls back to { module: key, componentKey: null } when the pattern does
 * not match so callers never receive undefined.
 *
 * @param   {string} key
 * @returns {{ module: string, componentKey: string | null }}
 */
function splitComponentKey(key) {
  if (!key) return { module: null, componentKey: null };
  const match = key.match(/^(.+-V\d+)-(.+)$/);
  if (!match) return { module: key, componentKey: null };
  return { module: match[1], componentKey: match[2] };
}

/**
 * Returns the actor that owns a state, according to the flow definition.
 * The definition is the single source of truth — stamped actor fields on
 * events are intentionally ignored here.
 *
 * @param   {string}      stateKey
 * @returns {string|null}
 */
function getActorForState(stateKey) {
  return workflowDefinition.states[stateKey]?.metadata?.actor ?? null;
}

/**
 * Finds the first state key in the flow definition that belongs to the given
 * actor.  This is the actor's designated entry node — returned when the actor
 * has no recorded events yet but their turn is coming (or already active).
 *
 * Definition order is preserved by Object.entries(), so the first match is
 * always the earliest node in the flow for that actor.
 *
 * @param   {string}      actor
 * @returns {string|null}
 */
function getActorEntryNode(actor) {
  for (const [stateKey, stateDef] of Object.entries(workflowDefinition.states)) {
    if (stateDef?.metadata?.actor === actor) return stateKey;
  }
  return null;
}

/**
 * Walks the states array backwards and returns the eventName of the most
 * recent entry that belongs to the given actor (resolved via the flow
 * definition, not the stamped actor field).
 *
 * @param   {Array<{eventName: string, actor?: string}>} statesArray
 * @param   {string}      actor
 * @returns {string|null}
 */
function resolveLatestEventForActor(statesArray, actor) {
  for (let i = statesArray.length - 1; i >= 0; i--) {
    const { eventName, actor: stampedActor } = statesArray[i];
    // Definition wins; fall back to stamped value only when definition has no entry
    const effectiveActor = getActorForState(eventName) ?? stampedActor;
    if (effectiveActor === actor) return eventName;
  }
  return null;
}

/**
 * Builds the standard response shape returned to callers.
 *
 * @param   {string} workflowId
 * @param   {string} workflowActor
 * @param   {string} stateKey
 * @param   {string} [status]  - "ACTIVE" (default) | "WAITING" | "NOT_YOUR_TURN"
 * @param   {string} [message] - optional human-readable context
 * @returns {object}
 */
function buildResponse(workflowId, workflowActor, stateKey, status = "ACTIVE", message = null) {
  return {
    workflowId,
    workflowActor,
    status,
    ...(message ? { message } : {}),
    componentviewrenderState: stateKey,
    componentviewrender: splitComponentKey(stateKey),
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — Data access  (DB only, no business logic)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetches the workflow row from the database.
 * Throws with a meaningful statusCode if the row is absent.
 *
 * @param   {string} workflowId
 * @returns {Promise<object>}
 */
async function fetchWorkflowRow(workflowId) {
  const rows = await sql`
    SELECT * FROM work_identifiers
    WHERE workflow_id = ${workflowId}
    LIMIT 1
  `;

  if (!rows || rows.length === 0) {
    const err = new Error(`Workflow '${workflowId}' not found`);
    err.statusCode = 404;
    throw err;
  }

  return rows[0];
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — Rule Engine wrapper  (single-responsibility: evaluate one state)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Evaluates all outgoing edges for a given state key against the current
 * workflow domain context.  Returns the first edge whose rule passes, or
 * null when no edge matches.
 *
 * @param   {string} stateKey       - e.g. "BORROWER-DETAILS-V1-PERSONAL-INFO-V1"
 * @param   {string} workflowId     - used to load the domain context
 * @returns {Promise<{ nextState: string, edgeId: string } | null>}
 */
async function evaluateEdges(stateKey, workflowId) {
  const stateDefinition = workflowDefinition.states[stateKey];

  // Unknown state → treat as no-match (null).
  // Navigator will fall back to the previous valid event.
  // realdecider validates the state before calling here, so this path
  // only surfaces for stale/bad currentState values in the DB.
  if (!stateDefinition) {
    console.warn(`[evaluateEdges] State '${stateKey}' not found in flow definition → returning null`);
    return null;
  }

  const workflowContext = await buildWorkflowContext(workflowId);
  setContextKey("workflowContext", workflowContext);

  console.log(
    `[evaluateEdges] state=${stateKey} | context=`,
    JSON.stringify(workflowContext, null, 2)
  );

  const edges = stateDefinition.edges ?? {};

  for (const [edgeId, edge] of Object.entries(edges)) {
    const passed = evaluateRuleEngine(workflowContext, edge.ruleEngine);
    console.log(`[evaluateEdges] edge=${edgeId} → ${edge.toState} | passed=${passed}`);
    if (passed) return { nextState: edge.toState, edgeId };
  }

  console.warn(`[evaluateEdges] No edge matched for state: ${stateKey}`);
  return null;
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — Actor-access resolver
//
// Responsibility: given a candidate node (the Rule Engine's answer), decide
// what the requesting actor should actually see.
//
// Decision tree (mirrors the spec exactly):
//   - Target node belongs to actor  → return it as-is
//   - Target node belongs to other  → find actor's latest event
//       → evaluate that event's edges → return resulting node
//       → if no edge → return the actor's latest event itself
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param   {string}   targetNode     - node selected by Rule Engine from loan event
 * @param   {string}   actor          - requesting actor
 * @param   {Array}    statesArray    - full states history from workflow row
 * @param   {string}   workflowId
 * @returns {Promise<string>}         - the node this actor should see
 */
async function resolveNodeForActor(targetNode, actor, statesArray, workflowId) {
  const targetActor = getActorForState(targetNode);

  // ── 4a. Actor owns the target node → return it directly ─────────────────
  if (!targetActor || targetActor === actor) {
    console.log(
      `[resolveNodeForActor] Actor '${actor}' owns target '${targetNode}' → returning directly`
    );
    return { node: targetNode, status: "ACTIVE", message: null };
  }

  // ── 4b. Node belongs to someone else → actor fallback path ──────────────
  console.log(
    `[resolveNodeForActor] '${targetNode}' belongs to '${targetActor}', not '${actor}' → fallback`
  );

  const actorLatestEvent = resolveLatestEventForActor(statesArray, actor);

  // Actor has no recorded events yet — their turn hasn't come
  if (!actorLatestEvent) {
    const entryNode = getActorEntryNode(actor);
    if (!entryNode) {
      const err = new Error(
        `Actor '${actor}' has no nodes defined in the flow definition`
      );
      err.statusCode = 403;
      throw err;
    }
    console.log(
      `[resolveNodeForActor] Actor '${actor}' has no events yet → entry node: ${entryNode} (NOT_YOUR_TURN)`
    );
    return {
      node: entryNode,
      status: "NOT_YOUR_TURN",
      message: `Workflow has not reached the ${actor} stage yet`,
    };
  }

  console.log(`[resolveNodeForActor] Actor latest event: ${actorLatestEvent}`);

  // Evaluate actor's latest event — but do NOT re-evaluate the loan
  const actorEdgeResult = await evaluateEdges(actorLatestEvent, workflowId);

  const actorNode = actorEdgeResult?.nextState ?? actorLatestEvent;
  const actorNodeActor = getActorForState(actorNode);
  const nodeStatus = (!actorNodeActor || actorNodeActor === actor) ? "ACTIVE" : "WAITING";

  console.log(`[resolveNodeForActor] Actor node resolved to: ${actorNode} (${nodeStatus})`);

  return { node: actorNode, status: nodeStatus, message: null };
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 5 — Event publisher helper
//
// Responsibility: derive authoritative actor from definition and publish the
// state-transition event.  Pure side-effect — returns the published event.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param   {string} workflowId
 * @param   {string} requestActor      - actor as sent by the caller
 * @param   {string} completedStep     - the state key that was just completed
 * @param   {object} workflowEvents    - current events object from DB
 * @returns {Promise<object>}          - published event
 */
async function publishStateTransition(
  workflowId,
  requestActor,
  completedStep,
  workflowEvents
) {
  // Always use the definition's actor to prevent bad request data being stamped
  const authorativeActor =
    getActorForState(completedStep) ?? requestActor;

  const { module: modulePart, componentKey } = splitComponentKey(completedStep);

  // Parse version tokens from the composite key segments
  const moduleParts   = modulePart.split("-");
  const moduleVersion = moduleParts[moduleParts.length - 1];          // e.g. "V1"
  const moduleName    = moduleParts.slice(1, -1).join("-");           // e.g. "BORROWER-DETAILS"

  const nodeParts  = (componentKey ?? completedStep).split("-");
  const nodeVersion = nodeParts[nodeParts.length - 1];               // e.g. "V1"
  const nodeName    = nodeParts.slice(0, -1).join("-");              // e.g. "PERSONAL-INFO"

  const event = {
    workflowId,
    actor: authorativeActor,
    eventName: completedStep,
    metadata: {
      actor: authorativeActor,
      module: moduleName,
      moduleVersion,
      node: nodeName,
      nodeVersion,
    },
    workflowEvents,
  };

  console.log("[publishStateTransition] Publishing:", JSON.stringify(event, null, 2));
  return eventPublisher.publish(event);
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 6 — Context bootstrap
//
// Responsibility: hydrate the request-scoped AsyncLocalStorage with workflow
// data so that downstream services (rule engine, datastore) can read it.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} workflowRow   - raw DB row
 * @param {string} actor
 * @param {string} [completedStep]
 */
function hydrateContext(workflowRow, actor, completedStep) {
  setContextKey("workflowId",        workflowRow.workflow_id);
  setContextKey("workflowActor",     actor);
  setContextKey("workflowEvents",    workflowRow.events);
  setContextKey("workflowStartNode", workflowDefinition.startState);
  if (completedStep !== undefined) {
    setContextKey("currentCompletedStep", completedStep);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// Section 7 — Public API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * decideNextState
 *
 * Entry point for READ operations (no state transition published).
 * Used when the frontend polls "where should I send this actor next?".
 *
 * Pipeline:
 *   fetch row → hydrate context → latest loan event
 *   → evaluate edges → check actor access → return node
 *
 * @param   {object} input
 * @param   {string} input.WORKFLOW_ID
 * @param   {string} input.WORKFLOW_ACTOR
 * @returns {Promise<object>}
 */
async function decideNextState(input = {}) {
  const data = input.datafromWorkflowIdentifier ?? input;
  const { WORKFLOW_ACTOR } = data;
  const workflowId =
    data.WORKFLOW_ID ??
    data.workflow_identifier ??
    data.workflow_id ??
    data.id;

  console.log(
    `[decideNextState] START | workflowId=${workflowId} | actor=${WORKFLOW_ACTOR}`
  );

  if (!workflowId) {
    const err = new Error("WORKFLOW_ID is required");
    err.statusCode = 400;
    throw err;
  }

  // ── 1. Fetch DB row ──────────────────────────────────────────────────────
  const workflowRow   = await fetchWorkflowRow(workflowId);
  const workflowEvents = workflowRow.events;
  const statesArray    = Array.isArray(workflowEvents?.states)
    ? workflowEvents.states
    : [];

  hydrateContext(workflowRow, WORKFLOW_ACTOR);

  // ── 2. No events yet ─────────────────────────────────────────────────────
  // The workflow hasn't started at all. Only the actor who owns the start
  // node should get a page. Everyone else is told it's not their turn yet.
  if (statesArray.length === 0) {
    const startNode      = workflowDefinition.startState;
    const startNodeActor = getActorForState(startNode);

    if (!startNodeActor || startNodeActor === WORKFLOW_ACTOR) {
      console.log(`[decideNextState] No events, actor owns start node → ${startNode}`);
      return buildResponse(workflowId, WORKFLOW_ACTOR, startNode, "ACTIVE");
    }

    // This actor's stage hasn't been reached yet — tell them clearly
    console.log(
      `[decideNextState] No events yet and actor '${WORKFLOW_ACTOR}' does not own start node → NOT_YOUR_TURN`
    );
    const actorEntryNode = getActorEntryNode(WORKFLOW_ACTOR);
    return buildResponse(
      workflowId,
      WORKFLOW_ACTOR,
      actorEntryNode ?? startNode,
      "NOT_YOUR_TURN",
      `Workflow has not reached the ${WORKFLOW_ACTOR} stage yet`
    );
  }

  // ── 3. Latest LOAN event ─────────────────────────────────────────────────
  // currentState may be stale/invalid (e.g. a state key that no longer exists
  // in the definition). Walk back through the states array to find the last
  // event that IS in the definition.
  const rawCurrentState =
    workflowEvents.currentState ??
    statesArray[statesArray.length - 1]?.eventName;

  const latestLoanEvent = (() => {
    // If the stored currentState is valid, use it
    if (rawCurrentState && workflowDefinition.states[rawCurrentState]) {
      return rawCurrentState;
    }
    // Otherwise walk back to find the last known-good event
    console.warn(
      `[decideNextState] currentState '${rawCurrentState}' not in definition → scanning states array`
    );
    for (let i = statesArray.length - 1; i >= 0; i--) {
      const name = statesArray[i].eventName;
      if (workflowDefinition.states[name]) return name;
    }
    // Nothing valid in history either → use the flow start node
    console.warn(`[decideNextState] No valid state found in history → using startState`);
    return workflowDefinition.startState;
  })();

  console.log(`[decideNextState] Latest loan event: ${latestLoanEvent}`);

  // ── 4. Evaluate Rule Engine on loan event ────────────────────────────────
  const edgeResult = await evaluateEdges(latestLoanEvent, workflowId);

  // Navigator is read-only: no edge match is NOT an error.
  // The loan is at a terminal or pending state — return the current node.
  const candidateNode = edgeResult
    ? edgeResult.nextState
    : latestLoanEvent;

  if (edgeResult) {
    console.log(
      `[decideNextState] Edge matched: ${latestLoanEvent} → ${edgeResult.nextState} (edge ${edgeResult.edgeId})`
    );
  } else {
    console.log(
      `[decideNextState] No edge matched → returning current node: ${latestLoanEvent}`
    );
  }

  // ── 5. Resolve node for requesting actor ─────────────────────────────────
  const { node: actorNode, status: actorStatus, message: actorMessage } =
    await resolveNodeForActor(
      candidateNode,
      WORKFLOW_ACTOR,
      statesArray,
      workflowId
    );

  return buildResponse(workflowId, WORKFLOW_ACTOR, actorNode, actorStatus, actorMessage);
}


/**
 * realdecider
 *
 * Entry point for WRITE operations.
 * Called when the actor completes a step (form submission, action taken).
 *
 * Pipeline:
 *   validate → fetch row → hydrate context
 *   → publish STATE_TRANSITION event
 *   → evaluate edges (re-fetch fresh context post-publish)
 *   → return decision
 *
 * @param   {object} input
 * @param   {string} input.WORKFLOW_ID
 * @param   {string} input.WORKFLOW_ACTOR
 * @param   {string} input.CURRENTCOMPLETEDSTEP
 * @returns {Promise<object>}
 */
function resolveStateKey(step) {
  if (!step) return null;
  if (workflowDefinition.states[step]) return step;

  // Try singular/plural normalization (e.g. BORROWER-DOCUMENTS- -> BORROWER-DOCUMENT-)
  const singularDoc = step.replace("-DOCUMENTS-", "-DOCUMENT-");
  if (workflowDefinition.states[singularDoc]) return singularDoc;

  const pluralDoc = step.replace("-DOCUMENT-", "-DOCUMENTS-");
  if (workflowDefinition.states[pluralDoc]) return pluralDoc;

  // Case-insensitive lookup
  const lowerStep = step.toLowerCase();
  for (const key of Object.keys(workflowDefinition.states)) {
    if (key.toLowerCase() === lowerStep) return key;
  }

  return null;
}

/**
 * @param   {object} input
 * @param   {string} input.WORKFLOW_ID
 * @param   {string} input.WORKFLOW_ACTOR
 * @param   {string} input.CURRENTCOMPLETEDSTEP
 * @returns {Promise<object>}
 */
async function realdecider(input = {}) {
  const data = input.datafromWorkflowIdentifier ?? input;
  const { WORKFLOW_ACTOR } = data;
  const workflowId = data.WORKFLOW_ID;
  const rawStep = data.CURRENTCOMPLETEDSTEP;
  const CURRENTCOMPLETEDSTEP = resolveStateKey(rawStep);

  console.log(
    `[realdecider] START | workflowId=${workflowId} | actor=${WORKFLOW_ACTOR} | step=${CURRENTCOMPLETEDSTEP} (raw: ${rawStep})`
  );

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!workflowId) {
    const err = new Error("WORKFLOW_ID is required");
    err.statusCode = 400;
    throw err;
  }
  if (!rawStep) {
    const err = new Error("CURRENTCOMPLETEDSTEP is required");
    err.statusCode = 400;
    throw err;
  }
  if (!CURRENTCOMPLETEDSTEP) {
    const err = new Error(
      `Step '${rawStep}' is not a valid state in the flow definition. ` +
      `Check componentViewRenderState in the request.`
    );
    err.statusCode = 400;
    throw err;
  }

  // ── 1. Fetch DB row ──────────────────────────────────────────────────────
  const workflowRow    = await fetchWorkflowRow(workflowId);
  const workflowEvents = workflowRow.events;

  hydrateContext(workflowRow, WORKFLOW_ACTOR, CURRENTCOMPLETEDSTEP);

  // ── 2. Publish the state-transition event ────────────────────────────────
  await publishStateTransition(
    workflowId,
    WORKFLOW_ACTOR,
    CURRENTCOMPLETEDSTEP,
    workflowEvents
  );

  // ── 3. Evaluate edges (context is now up-to-date post-publish) ───────────
  return decisionManager({ workflowId, workflowActor: WORKFLOW_ACTOR, CURRENTCOMPLETEDSTEP });
}


/**
 * decisionManager
 *
 * Low-level decision primitive used internally by both realdecider and
 * decideNextState (actor fallback path).  Evaluates edges for the given
 * completed step and returns a structured decision object.
 *
 * This function does NOT publish events and does NOT touch actor access —
 * those concerns belong to the callers above.
 *
 * @param   {{ workflowId: string, workflowActor: string, CURRENTCOMPLETEDSTEP: string }} params
 * @returns {Promise<object>}
 */
async function decisionManager({ workflowId, workflowActor, CURRENTCOMPLETEDSTEP }) {
  console.log(
    `[decisionManager] Evaluating: workflowId=${workflowId} | step=${CURRENTCOMPLETEDSTEP}`
  );

  const edgeResult = await evaluateEdges(CURRENTCOMPLETEDSTEP, workflowId);

  // Write path (eventCreaterAndProcesser): no edge match is a hard error.
  // The actor submitted a step but the workflow has no valid transition from it.
  if (!edgeResult) {
    const err = new Error(
      `No edge matched for completed step '${CURRENTCOMPLETEDSTEP}'. Cannot advance workflow.`
    );
    err.statusCode = 422;
    throw err;
  }

  const { nextState, edgeId } = edgeResult;

  console.log(
    `[decisionManager] Decision: ${CURRENTCOMPLETEDSTEP} → ${nextState} via edge ${edgeId}`
  );

  return {
    workflowId,
    workflowActor,
    decided:                  true,
    completedStep:            CURRENTCOMPLETEDSTEP,
    matchedEdgeId:            edgeId,
    nextState,
    componentviewrenderState: nextState,
    componentviewrender:      splitComponentKey(nextState),
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// Exports
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Public API
  decideNextState,
  realdecider,
  decisionManager,

  // Re-exported for consumers that import the definition from here
  workflowDefinition,

  // Exposed for unit testing
  _internals: {
    splitComponentKey,
    getActorForState,
    getActorEntryNode,
    resolveLatestEventForActor,
    evaluateEdges,
    resolveNodeForActor,
    publishStateTransition,
    buildResponse,
    fetchWorkflowRow,
    hydrateContext,
  },
};
