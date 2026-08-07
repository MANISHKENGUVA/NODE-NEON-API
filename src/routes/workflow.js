const express = require("express");
const { createWorkIdentifierTable } = require("../config/db");
const { recordWorkflow, appendWorkflowEvent } = require("../services/workflowRecorder");
const { decideNextState, workflowDefinition, realdecider } = require("../services/workflowDecider");
const { navigatorService } = require("../services/navigationservice");
const { dispatchEventTypeStorage, createDomainDatastoreTable } = require("../services/domainDatastore");
const {
  createWorkflowIdentifier,
  getWorkflowIdentifier,
  listWorkflowIdentifiers,
  updateWorkflowIdentifier,
  createWorkIdentifierRecord,
} = require("../services/workflowIdentifier");

const router = express.Router();

/**
 * POST /api/workflow/identifier
 * Creates a new unique workflowIdentifier record in DB and initializes workflow state.
 */
router.post("/identifier", async (req, res, next) => {
  try {
    const result = await createWorkflowIdentifier(req.body);
    res.status(201).json({
      success: true,
      message: "Workflow identifier created successfully",
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/workflow/workidentifier
 * Creates a new work_identifiers record with custom events
 */
router.post("/workidentifier", async (req, res, next) => {
  try {
    const result = await createWorkIdentifierRecord(req.body);
    res.status(201).json({
      success: true,
      message: "Work identifier created successfully",
      data: result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/workflow/createdb
 * Route to explicitly create the work_identifiers table in the database
 */
router.post("/createdb", async (req, res, next) => {
  try {
    const result = await createWorkIdentifierTable();
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/workflow/identifiers
 * Lists workflow identifiers with optional pagination and filters (status, workflow_id).
 */
router.get("/identifiers", async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const { status, workflow_id } = req.query;

    const list = await listWorkflowIdentifiers({ limit, offset, status, workflow_id });
    res.json({
      success: true,
      count: list.length,
      data: list,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/workflow/identifier/:identifier
 * Gets workflow details and event logs for a given workflowIdentifier string.
 */
router.get("/identifier/:identifier", async (req, res, next) => {
  try {
    const data = await getWorkflowIdentifier(req.params.identifier);
    res.json({
      success: true,
      data,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/workflow/identifier/:identifier
 * Updates current_state, status, or context for a workflowIdentifier.
 */
router.patch("/identifier/:identifier", async (req, res, next) => {
  try {
    const updated = await updateWorkflowIdentifier(req.params.identifier, req.body);
    res.json({
      success: true,
      data: updated,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/workflow/recorder-decider
 * Records a state event and evaluates the next workflow state.
 */
router.post("/recorder-decider", async (req, res, next) => {
  try {
    const {
      id,
      workflow_identifier,
      workflow_id,
      version = 1,
      start_node,
      started_at,
      events_json,
      status,
      currentState,
      context = {},
      workflowId,
    } = req.body;

    const activeWorkflowId = workflowId || workflow_id || workflowDefinition.workflowId;
    const stateForDecision = currentState || start_node;

    if (!stateForDecision) {
      return res.status(400).json({
        success: false,
        message: "currentState or start_node is required",
      });
    }

    const record = await recordWorkflow({
      id,
      workflow_identifier,
      workflow_id: activeWorkflowId,
      version,
      start_node: stateForDecision,
      started_at,
      events_json,
      status,
    });

    const decision = await decideNextState({
      currentState: stateForDecision,
      context,
      workflowId: activeWorkflowId,
      workflow_identifier,
    });

    let updatedRecord = record;

    if (decision.decided) {
      updatedRecord = await appendWorkflowEvent(workflow_identifier || record.id, {
        node: decision.nextState,
        action: "DECIDED",
        fromState: stateForDecision,
        edgeId: decision.matchedEdges[0]?.edgeId,
        timestamp: new Date().toISOString(),
      });

      if (workflow_identifier) {
        await updateWorkflowIdentifier(workflow_identifier, {
          current_state: decision.nextState,
          context,
        });
      }
    }

    res.status(id || workflow_identifier ? 200 : 201).json({
      success: true,
      data: {
        record: updatedRecord,
        decision,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/recorder/:id/events", async (req, res, next) => {
  try {
    const record = await appendWorkflowEvent(req.params.id, req.body);
    res.json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
});

router.post("/decider", async (req, res, next) => {
  try {
    const result = await decideNextState(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});



/**
 * POST /api/workflow/navigator & POST /api/workflow/workflow-navigator
 */
const navigatorHandler = async (req, res, next) => {
  try {
    const { WORKFLOW_ID, WORKFLOW_ACTOR } = req.body;

    console.log("WORKFLOW_ID from navigate:", WORKFLOW_ID);
    console.log("WORKFLOW_ACTOR from navigate:", WORKFLOW_ACTOR);

    const result = await navigatorService(req.body);

    res.json({
      success: true,
      message: result?.decided
        ? `Navigating to ${result.nextState}`
        : "Navigation processed",
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

router.post("/navigator", navigatorHandler);
router.post("/workflow-navigator", navigatorHandler);

/**
 * POST /api/workflow/eventCreaterAndProcesser
 * Receives a completed step event + formData, publishes the event,
 * evaluates workflow edges, and returns the next node to render.
 *
 * Body:
 *   eventType                                 — e.g. "PERSONAL_INFO_SUBMITTED"
 *   workflowMetadata.workflowId               — e.g. "WF-101"
 *   workflowMetadata.workflowActor            — e.g. "BORROWER"
 *   workflowMetadata.componentViewRenderState — e.g. "BORROWER-DETAILS-V1-PERSONAL-INFO-V1"
 *   formData                                  — submitted form fields for edge evaluation
 */
router.post("/eventCreaterAndProcesser", async (req, res, next) => {
  try {
    console.log("[eventCreaterAndProcesser] request.body:", JSON.stringify(req.body, null, 2));

    const { eventType, workflowMetadata = {}, formData = {} } = req.body;
    const { workflowId, workflowActor, componentViewRenderState } = workflowMetadata;

    // ── Step 1: persist formData into the correct domain table ─────────────────
    const domainRecord = await dispatchEventTypeStorage(eventType, workflowId, formData);
    console.log("[eventCreaterAndProcesser] domain storage result:", JSON.stringify(domainRecord, null, 2));

    // ── Step 2: publish event + evaluate edges → get next node ─────────────────
    const result = await realdecider({
      WORKFLOW_ID: workflowId,
      WORKFLOW_ACTOR: workflowActor,
      CURRENTCOMPLETEDSTEP: componentViewRenderState,
      formData,
    });
      // res.status(200).json({ success: true, data: { domainRecord, ...result } });

    res.status(200).json({ success: true, data: {  ...result } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/workflow/createDomainDatastoreTable
 * Creates the domain_datastore table in the DB.
 */
router.post("/createDomainDatastoreTable", async (req, res, next) => {
  try {
    const result = await createDomainDatastoreTable();
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.navigatorHandler = navigatorHandler;

