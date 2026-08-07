const { sql } = require("../config/db");

async function recordWorkflow({
  id,
  workflow_identifier,
  workflow_id,
  version,
  start_node,
  started_at,
  events_json,
  status,
}) {
  if (id) {
    if (events_json === undefined && status === undefined) {
      const error = new Error("Provide events_json or status to update");
      error.statusCode = 400;
      throw error;
    }

    let record;

    if (events_json !== undefined && status !== undefined) {
      [record] = await sql`
        UPDATE workflow_events
        SET events_json = ${JSON.stringify(events_json)}, status = ${status}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
    } else if (events_json !== undefined) {
      [record] = await sql`
        UPDATE workflow_events
        SET events_json = ${JSON.stringify(events_json)}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
    } else {
      [record] = await sql`
        UPDATE workflow_events
        SET status = ${status}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;
    }

    if (!record) {
      const error = new Error("Workflow record not found");
      error.statusCode = 404;
      throw error;
    }

    return record;
  }

  if (!workflow_id || version == null || !start_node) {
    const error = new Error("workflow_id, version, and start_node are required");
    error.statusCode = 400;
    throw error;
  }

  const [record] = await sql`
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
      ${workflow_identifier ?? null},
      ${workflow_id},
      ${version},
      ${start_node},
      ${started_at ? new Date(started_at) : new Date()},
      ${JSON.stringify(events_json ?? [])},
      ${status ?? "IN_PROGRESS"}
    )
    RETURNING *
  `;

  return record;
}

async function appendWorkflowEvent(idOrIdentifier, event) {
  if (!idOrIdentifier || !event) {
    const error = new Error("id / workflow_identifier and event are required");
    error.statusCode = 400;
    throw error;
  }

  const isUuid = typeof idOrIdentifier === "string" && idOrIdentifier.includes("-") && idOrIdentifier.length === 36;
  const eventJsonStr = JSON.stringify([event]);
  
  let record;
  if (isUuid) {
    [record] = await sql`
      UPDATE workflow_events
      SET
        events_json = COALESCE(events_json, '[]'::jsonb) || ${eventJsonStr}::jsonb,
        updated_at = NOW()
      WHERE id = ${idOrIdentifier}
      RETURNING *
    `;
  } else {
    [record] = await sql`
      UPDATE workflow_events
      SET
        events_json = COALESCE(events_json, '[]'::jsonb) || ${eventJsonStr}::jsonb,
        updated_at = NOW()
      WHERE workflow_identifier = ${idOrIdentifier}
      RETURNING *
    `;
  }

  if (!record) {
    const error = new Error("Workflow record not found");
    error.statusCode = 404;
    throw error;
  }

  return record;
}

module.exports = { recordWorkflow, appendWorkflowEvent };
