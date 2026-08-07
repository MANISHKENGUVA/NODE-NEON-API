const workflowDefinition = require("../FLOWDESIGNER/FLOWDESINGER.json");
const { evaluateRuleEngine } = require("./ruleEngine");
const { sql } = require("../config/db");
const { getContextKey, setContextKey } = require("../context");
const eventPublisher = require("./eventPublisher");
const { buildWorkflowContext } = require("./domainDatastore");



function splitComponentKey(key) {
  // Split on the version suffix that acts as a separator: -V<number>-
  const match = key.match(/^(.+-V\d+)-(.+)$/);
  if (!match) return { component: key, subComponent: null };
  return {
    module: match[1],      // "BORROWER-DETAILS-V1"
    componentKey: match[2],   // "PERSONAL-INFO-V1"
  };
}


async function decideNextState(input = {}) {
  const data = input.datafromWorkflowIdentifier || input;
  const { WORKFLOW_ID, WORKFLOW_ACTOR } = data;
  console.log("datafromWorkflowIdentifier", WORKFLOW_ID, WORKFLOW_ACTOR);

  const activeWorkflowVersion = workflowDefinition.workflowVersion;

  if (!WORKFLOW_ID && !activeWorkflowVersion) {
    const error = new Error(`Workflow '${WORKFLOW_ID}' is not supported`);
    error.statusCode = 404;
    throw error;
  }



  let workflowRow = null;

  const targetId = WORKFLOW_ID || data.workflow_identifier || data.workflow_id || data.id;

  if (targetId) {
    try {
      console.log("Searching DB for workflow identifier:", targetId);
      
      // Check work_identifiers table first (table containing WF-101)
      const workRecords = await sql`
        SELECT * FROM work_identifiers
        WHERE workflow_id = ${targetId}
        LIMIT 1
      `;

      if (workRecords && workRecords.length > 0) {
        workflowRow = workRecords[0];
        console.log('workflowRowDATA (from 1work_identifiers):', JSON.stringify(workflowRow, null, 2));
        setContextKey('workflowId', workflowRow.workflow_id);
        setContextKey('workflowActor', WORKFLOW_ACTOR);
        setContextKey('workflowEvents', workflowRow.events);
        setContextKey('workflowStartNode', workflowRow.events?.startState);

        console.log('[Context Keys Set]', {
          workflowId: getContextKey('workflowId'),
          workflowActor: getContextKey('workflowActor'),
          workflowEvents: getContextKey('workflowEvents'),
          workflowStartNode: getContextKey('workflowStartNode'),
        });

        const workflowId = getContextKey('workflowId');
        const workflowActor = getContextKey('workflowActor');
        const workflowEvents = getContextKey('workflowEvents');
        const workflowStartNode = getContextKey('workflowStartNode');
        const statesArray = Array.isArray(workflowEvents.states) ? workflowEvents.states : [];

        if (statesArray.length === 0) {
          console.log('[WorkflowDecider] No current state — returning start node:', workflowStartNode);

    

          return {
            workflowId,
            workflowActor,
            componentviewrenderState: workflowStartNode,
            componentviewrender: splitComponentKey(workflowStartNode),
          };
        } else {
          // Workflow already in progress — resume from latest node in states array
          const latestNode = workflowEvents.currentState
            || (statesArray.length > 0 ? statesArray[statesArray.length - 1].eventName : null);
          console.log('[WorkflowDecider] Existing states — resuming at latest node:', latestNode);

          return {
            workflowId,
            workflowActor,
            componentviewrenderState: latestNode,
            componentviewrender: splitComponentKey(latestNode),
          };
        }


        

        
        
      } 
      else{
        
      }
    } catch (err) {
      console.error("Error fetching workflow identifier row:", err.message);
    }
  }


  
}
async function realdecider(input = {}) {
  const data = input.datafromWorkflowIdentifier || input;
  const { WORKFLOW_ID, WORKFLOW_ACTOR, CURRENTCOMPLETEDSTEP} = data;

  console.log('[realdecider] START — WORKFLOW_ID:', WORKFLOW_ID, '| WORKFLOW_ACTOR:', WORKFLOW_ACTOR, '| CURRENTCOMPLETEDSTEP:', CURRENTCOMPLETEDSTEP);

  if (!WORKFLOW_ID) {
    const error = new Error('WORKFLOW_ID is required');
    error.statusCode = 400;
    throw error;
  }

  if (!CURRENTCOMPLETEDSTEP) {
    const error = new Error('CURRENTCOMPLETEDSTEP is required');
    error.statusCode = 400;
    throw error;
  }

  // ── 1. Fetch workflow row from DB ────────────────────────────────────────────
  const workRecords = await sql`
    SELECT * FROM work_identifiers
    WHERE workflow_id = ${WORKFLOW_ID}
    LIMIT 1
  `;

  if (!workRecords || workRecords.length === 0) {
    const error = new Error(`Workflow '${WORKFLOW_ID}' not found in DB`);
    error.statusCode = 404;
    throw error;
  }

  const workflowRow = workRecords[0];
  console.log('[realdecider] workflowRow fetched:', JSON.stringify(workflowRow, null, 2));

  // ── 2. Set context keys ──────────────────────────────────────────────────────
  setContextKey('workflowId', workflowRow.workflow_id);
  setContextKey('workflowActor', WORKFLOW_ACTOR);
  setContextKey('workflowEvents', workflowRow.events);
  setContextKey('workflowStartNode', workflowRow.events?.startState);
  setContextKey('currentCompletedStep', CURRENTCOMPLETEDSTEP);

  const workflowId       = getContextKey('workflowId');
  const workflowActor    = getContextKey('workflowActor');
  const workflowEvents   = getContextKey('workflowEvents');

  // ── 3. Parse metadata from the completed step key ───────────────────────────
  // Key format: ACTOR-MODULE-MV-NODE-NV  e.g. "BORROWER-DETAILS-V1-PERSONAL-INFO-V1"
  const { module: parsedModule, componentKey } = splitComponentKey(CURRENTCOMPLETEDSTEP);
  const moduleParts   = parsedModule.split('-');                   // ["BORROWER","DETAILS","V1"]
  const moduleVersion = moduleParts[moduleParts.length - 1];       // "V1"
  const moduleName    = moduleParts.slice(1, -1).join('-');         // "DETAILS"
  const nodeParts     = componentKey.split('-');                   // ["PERSONAL","INFO","V1"]
  const nodeVersion   = nodeParts[nodeParts.length - 1];           // "V1"
  const nodeName      = nodeParts.slice(0, -1).join('-');           // "PERSONAL-INFO"

  console.log('[realdecider] Parsed metadata —', { moduleName, moduleVersion, nodeName, nodeVersion });

  // ── 4. Publish the STATE_TRANSITION event for the completed step ─────────────
  const EVENT = {
    workflowId,
    actor: workflowActor,
    eventName: CURRENTCOMPLETEDSTEP,
    metadata: {
      actor: workflowActor,
      module: moduleName,
      moduleVersion,
      node: nodeName,
      nodeVersion,
    },
    workflowEvents,
  };

  console.log('[realdecider] Publishing event:', JSON.stringify(EVENT, null, 2));
  await eventPublisher.publish(EVENT);

  // ── 5 & 6. Build full domain context from DB, store in context, then decide
  // Fetches the single domain_datastore row for this workflowId.
  // Result is the full multi-domain object ruleEngine evaluates against:
  // { APPLICATION: { currentStep: "..." }, PERSONALDETAILS: { basicInfoCompleted: true }, ... }
  // const workflowContext = await buildWorkflowContext(workflowId);
  // setContextKey('workflowContext', workflowContext);

  // console.log('[realdecider] workflowContext set in context:', JSON.stringify(workflowContext, null, 2));

  return decisionManager({ workflowId, workflowActor, CURRENTCOMPLETEDSTEP});
}

/**
 * decisionManager
 * Looks up the completed state in the workflow definition, evaluates its edges
 * against the full domain context (workflowContext), and returns the next node.
 *
 * workflowContext shape (from buildWorkflowContext):
 * {
 *   APPLICATION:     { currentStep: "PERSONAL_INFO_COMPLETED" },
 *   PERSONALDETAILS: { basicInfoCompleted: true, ... },
 *   ADDRESS:         { current: { isValid: true, ... } },
 *   ...
 * }
 *
 * ruleEngine field "APPLICATION.currentStep" resolves to:
 *   workflowContext["APPLICATION"]["currentStep"]
 * via getFieldValue dot-path traversal in ruleEngine.js
 */
async function decisionManager({ workflowId, workflowActor, CURRENTCOMPLETEDSTEP,  }) {
  const stateDefinition = workflowDefinition.states[CURRENTCOMPLETEDSTEP];
    const workflowContext = await buildWorkflowContext(workflowId);
  setContextKey('workflowContext', workflowContext);

  console.log('[realdecider] workflowContext set in context:', JSON.stringify(workflowContext, null, 2));


  if (!stateDefinition) {
    const error = new Error(`State '${CURRENTCOMPLETEDSTEP}' not found in workflow definition`);
    error.statusCode = 404;
    throw error;
  }
   console.log('[realdecider] workflowContext set in context:', JSON.stringify(workflowContext, null, 2));
  const edges = stateDefinition.edges || {};
  console.log('[decisionManager] Evaluating edges for state:', CURRENTCOMPLETEDSTEP, '| edges:', Object.keys(edges));
  console.log('[decisionManager] Context:', JSON.stringify(workflowContext, null, 2));

  let nextState     = null;
  let matchedEdgeId = null;

  for (const [edgeId, edge] of Object.entries(edges)) {
    const passed = evaluateRuleEngine(workflowContext, edge.ruleEngine);
    console.log(`[decisionManager] Edge ${edgeId} → ${edge.toState} | passed: ${passed}`);
    if (passed) {
      nextState     = edge.toState;
      matchedEdgeId = edgeId;
      break; // first matching edge wins
    }
  }

  if (!nextState) {
    console.warn('[decisionManager] No edge matched for state:', CURRENTCOMPLETEDSTEP);
    return {
      workflowId,
      workflowActor,
      decided: false,
      completedStep: CURRENTCOMPLETEDSTEP,
      nextState: null,
      componentviewrenderState: null,
      componentviewrender: null,
    };
  }

  console.log('[decisionManager] Decision —', CURRENTCOMPLETEDSTEP, '→', nextState, 'via edge', matchedEdgeId);

  return {
    workflowId,
    workflowActor,
    decided: true,
    completedStep: CURRENTCOMPLETEDSTEP,
    matchedEdgeId,
    nextState,
    componentviewrenderState: nextState,
    componentviewrender: splitComponentKey(nextState),
  };
}

module.exports = { decideNextState, workflowDefinition, realdecider, decisionManager };

