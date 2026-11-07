const { getDriver } = require("./driver");
const { serviceUnavailable } = require("../core/errors");

function parsePayload(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

function normaliseEvent(workflowId, event, sequenceNumber) {
  return {
    eventId: event.eventId || `${workflowId}-${sequenceNumber}`,
    workflowId,
    sequenceNumber: Number(sequenceNumber),
    eventType: event.eventType || "UNKNOWN_EVENT",
    stepNumber: event.stepNumber ?? null,
    status: event.status || "COMPLETED",
    timestamp: event.timestamp || new Date().toISOString(),
    payloadJson: JSON.stringify(event.payload ?? {}),
    nodeKey: event.nodeKey ?? null,
    actor: event.actor ?? null,
    fromNode: event.fromNode ?? null,
    toNode: event.toNode ?? null,
    edgeId: event.edgeId ?? null,
  };
}

async function ensureSchema() {
  const driver = getDriver();
  if (!driver) return false;

  const session = driver.session();
  try {
    await session.run(`
      CREATE CONSTRAINT workflow_id_unique IF NOT EXISTS
      FOR (w:Workflow) REQUIRE w.workflowId IS UNIQUE
    `);

    await session.run(`
      CREATE CONSTRAINT workflow_event_id_unique IF NOT EXISTS
      FOR (e:WorkflowEvent) REQUIRE e.eventId IS UNIQUE
    `);

    await session.run(`
      CREATE CONSTRAINT workflow_event_sequence_unique IF NOT EXISTS
      FOR (e:WorkflowEvent)
      REQUIRE (e.workflowId, e.sequenceNumber) IS UNIQUE
    `);

    await session.run(`
      CREATE INDEX workflow_event_timestamp IF NOT EXISTS
      FOR (e:WorkflowEvent) ON (e.timestamp)
    `);

    await session.run(`
      CREATE INDEX workflow_event_workflow_sequence IF NOT EXISTS
      FOR (e:WorkflowEvent) ON (e.workflowId, e.sequenceNumber)
    `);

    return true;
  } finally {
    await session.close();
  }
}

async function upsertWorkflow(workflowId, { status = "IN_PROGRESS", createdAt = new Date(), updatedAt = new Date() } = {}) {
  const driver = getDriver();
  if (!driver) {
    throw serviceUnavailable("Neo4j workflow graph is disabled");
  }

  const session = driver.session();
  try {
    await session.run(
      `
        MERGE (w:Workflow {workflowId: $workflowId})
        ON CREATE SET w.createdAt = datetime($createdAt), w.status = $status
        SET w.updatedAt = datetime($updatedAt), w.status = $status
        RETURN w
      `,
      {
        workflowId,
        status,
        createdAt: new Date(createdAt).toISOString(),
        updatedAt: new Date(updatedAt).toISOString(),
      }
    );
    return true;
  } finally {
    await session.close();
  }
}

async function persistWorkflowEvents(workflowId, events = []) {
  const driver = getDriver();
  if (!driver) return [];

  const session = driver.session();
  try {
    const normalised = events.map((event, index) =>
      normaliseEvent(workflowId, event, event.sequenceNumber ?? index + 1)
    );

    await upsertWorkflow(workflowId, {
      status: "IN_PROGRESS",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    for (const event of normalised) {
      await session.run(
        `
          MATCH (w:Workflow {workflowId: $workflowId})
          MERGE (e:WorkflowEvent {eventId: $eventId})
          ON CREATE SET
            e.workflowId = $workflowId,
            e.sequenceNumber = $sequenceNumber,
            e.eventType = $eventType,
            e.stepNumber = $stepNumber,
            e.status = $status,
            e.timestamp = datetime($timestamp),
            e.payloadJson = $payloadJson,
            e.nodeKey = $nodeKey,
            e.actor = $actor,
            e.fromNode = $fromNode,
            e.toNode = $toNode,
            e.edgeId = $edgeId
          SET
            e.workflowId = $workflowId,
            e.sequenceNumber = $sequenceNumber,
            e.eventType = $eventType,
            e.stepNumber = $stepNumber,
            e.status = $status,
            e.timestamp = datetime($timestamp),
            e.payloadJson = $payloadJson,
            e.nodeKey = $nodeKey,
            e.actor = $actor,
            e.fromNode = $fromNode,
            e.toNode = $toNode,
            e.edgeId = $edgeId
          MERGE (w)-[:HAS_EVENT]->(e)
          RETURN e
        `,
        event
      );
    }

    return normalised.map((event) => ({
      ...event,
      payload: parsePayload(event.payloadJson),
    }));
  } finally {
    await session.close();
  }
}

async function listWorkflowEvents(workflowId, { limit = 200 } = {}) {
  const driver = getDriver();
  if (!driver) return [];

  const session = driver.session();
  try {
    const result = await session.run(
      `
        MATCH (w:Workflow {workflowId: $workflowId})-[:HAS_EVENT]->(e:WorkflowEvent)
        RETURN e
        ORDER BY e.sequenceNumber ASC
        LIMIT $limit
      `,
      { workflowId, limit: Number(limit) }
    );

    return result.records.map((record) => record.get("e").properties);
  } finally {
    await session.close();
  }
}

async function getWorkflowStatus(workflowId) {
  const driver = getDriver();
  if (!driver) return { workflowId, status: "UNKNOWN" };

  const session = driver.session();
  try {
    const result = await session.run(
      `
        MATCH (w:Workflow {workflowId: $workflowId})
        OPTIONAL MATCH (w)-[:HAS_EVENT]->(e:WorkflowEvent)
        WITH w, e
        ORDER BY e.sequenceNumber DESC
        LIMIT 1
        RETURN w.workflowId AS workflowId, w.status AS status, e.status AS lastEventStatus, e.eventType AS lastEventType
      `,
      { workflowId }
    );

    if (result.records.length === 0) return { workflowId, status: "UNKNOWN" };

    const row = result.records[0].toObject();
    return {
      workflowId: row.workflowId,
      status: row.status ?? row.lastEventStatus ?? "IN_PROGRESS",
      lastEventStatus: row.lastEventStatus,
      lastEventType: row.lastEventType,
    };
  } finally {
    await session.close();
  }
}

async function getFailedEvents(workflowId) {
  const driver = getDriver();
  if (!driver) return [];

  const session = driver.session();
  try {
    const result = await session.run(
      `
        MATCH (w:Workflow {workflowId: $workflowId})-[:HAS_EVENT]->(e:WorkflowEvent)
        WHERE e.status = 'FAILED' OR e.eventType ENDS WITH 'FAILED'
        RETURN e
        ORDER BY e.sequenceNumber ASC
      `,
      { workflowId }
    );

    return result.records.map((record) => record.get("e").properties);
  } finally {
    await session.close();
  }
}

module.exports = {
  ensureSchema,
  upsertWorkflow,
  persistWorkflowEvents,
  listWorkflowEvents,
  getWorkflowStatus,
  getFailedEvents,
  normaliseEvent,
};
