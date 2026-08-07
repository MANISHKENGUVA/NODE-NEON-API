const { sql } = require("../config/db");
const workflowDefinition = require("../FLOWDESIGNER/FLOWDESINGER.json");

/**
 * Generate a unique workflow identifier string.
 * Format: WF-{timestamp}-{random}
 */
function generateWorkflowIdentifier(prefix = "WF") {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Create a new workflow identifier instance in the database.
 */
async function createWorkflowIdentifier({
  workflow_id = workflowDefinition.workflowId,
  version = 1,
  initial_state,
  context = {},
  metadata = {},
  workflow_identifier,
}) {
  const startState = initial_state || workflowDefinition.startState;
  
  if (!startState) {
    const error = new Error("initial_state or valid workflow start state is required");
    error.statusCode = 400;
    throw error;
  }

  const identifier = workflow_identifier || generateWorkflowIdentifier();

  // Insert into workflow_identifiers table
  const [workflowRecord] = await sql`
    INSERT INTO workflow_identifiers (
      workflow_identifier,
      workflow_id,
      version,
      current_state,
      status,
      context,
      metadata
    )
    VALUES (
      ${identifier},
      ${workflow_id},
      ${version},
      ${startState},
      'IN_PROGRESS',
      ${JSON.stringify(context)},
      ${JSON.stringify(metadata)}
    )
    RETURNING *
  `;

  const initialEvents = [
    {
      node: startState,
      action: "INITIALIZED",
      timestamp: new Date().toISOString(),
      context,
    },
  ];

  // Create initial workflow_events entry
  const [eventRecord] = await sql`
    INSERT INTO workflow_events (
      workflow_identifier,
      workflow_id,
      version,
      start_node,
      started_at,
      events_json,
      status
    )
    VALUES (
      ${identifier},
      ${workflow_id},
      ${version},
      ${startState},
      NOW(),
      ${JSON.stringify(initialEvents)},
      'IN_PROGRESS'
    )
    RETURNING *
  `;

  return {
    ...workflowRecord,
    initialEvent: eventRecord,
  };
}

/**
 * Fetch a workflow identifier details along with its events history.
 */
async function getWorkflowIdentifier(workflow_identifier) {
  if (!workflow_identifier) {
    const error = new Error("workflow_identifier parameter is required");
    error.statusCode = 400;
    throw error;
  }

  const [workflowRecord] = await sql`
    SELECT * FROM workflow_identifiers
    WHERE workflow_identifier = ${workflow_identifier}
  `;

  if (!workflowRecord) {
    const error = new Error(`Workflow identifier '${workflow_identifier}' not found`);
    error.statusCode = 404;
    throw error;
  }

  const events = await sql`
    SELECT * FROM workflow_events
    WHERE workflow_identifier = ${workflow_identifier}
    ORDER BY created_at ASC
  `;

  return {
    ...workflowRecord,
    events,
  };
}

/**
 * List workflow identifiers with optional filtering and pagination.
 */
async function listWorkflowIdentifiers({ limit = 20, offset = 0, status, workflow_id } = {}) {
  let query;

  if (status && workflow_id) {
    query = sql`
      SELECT * FROM workflow_identifiers
      WHERE status = ${status} AND workflow_id = ${workflow_id}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (status) {
    query = sql`
      SELECT * FROM workflow_identifiers
      WHERE status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (workflow_id) {
    query = sql`
      SELECT * FROM workflow_identifiers
      WHERE workflow_id = ${workflow_id}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    query = sql`
      SELECT * FROM workflow_identifiers
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const records = await query;
  return records;
}

/**
 * Update active state, status, or context for a workflow identifier.
 */
async function updateWorkflowIdentifier(workflow_identifier, { current_state, status, context, metadata }) {
  if (!workflow_identifier) {
    const error = new Error("workflow_identifier is required");
    error.statusCode = 400;
    throw error;
  }

  const [existing] = await sql`
    SELECT * FROM workflow_identifiers
    WHERE workflow_identifier = ${workflow_identifier}
  `;

  if (!existing) {
    const error = new Error(`Workflow identifier '${workflow_identifier}' not found`);
    error.statusCode = 404;
    throw error;
  }

  const newCurrentState = current_state ?? existing.current_state;
  const newStatus = status ?? existing.status;
  const newContext = context ? { ...existing.context, ...context } : existing.context;
  const newMetadata = metadata ? { ...existing.metadata, ...metadata } : existing.metadata;

  const [updatedRecord] = await sql`
    UPDATE workflow_identifiers
    SET
      current_state = ${newCurrentState},
      status = ${newStatus},
      context = ${JSON.stringify(newContext)},
      metadata = ${JSON.stringify(newMetadata)},
      updated_at = NOW()
    WHERE workflow_identifier = ${workflow_identifier}
    RETURNING *
  `;

  return updatedRecord;
}

async function createWorkIdentifierRecord({ workflow_id, events }) {
  const wid = workflow_id || 'default-workflow';
  const eventPayload = events || {};
  
  const [record] = await sql`
    INSERT INTO work_identifiers (workflow_id, events)
    VALUES (${wid}, ${JSON.stringify(eventPayload)})
    RETURNING *
  `;
  return record;
}

module.exports = {
  generateWorkflowIdentifier,
  createWorkflowIdentifier,
  getWorkflowIdentifier,
  listWorkflowIdentifiers,
  updateWorkflowIdentifier,
  createWorkIdentifierRecord,
};
