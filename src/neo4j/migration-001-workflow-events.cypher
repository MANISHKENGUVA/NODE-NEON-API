CREATE CONSTRAINT workflow_id_unique IF NOT EXISTS
FOR (w:Workflow) REQUIRE w.workflowId IS UNIQUE;

CREATE CONSTRAINT workflow_event_id_unique IF NOT EXISTS
FOR (e:WorkflowEvent) REQUIRE e.eventId IS UNIQUE;

CREATE CONSTRAINT workflow_event_sequence_unique IF NOT EXISTS
FOR (e:WorkflowEvent)
REQUIRE (e.workflowId, e.sequenceNumber) IS UNIQUE;

CREATE INDEX workflow_event_timestamp IF NOT EXISTS
FOR (e:WorkflowEvent) ON (e.timestamp);

CREATE INDEX workflow_event_workflow_sequence IF NOT EXISTS
FOR (e:WorkflowEvent) ON (e.workflowId, e.sequenceNumber);

// Workflow example:
// (:Workflow {workflowId, status, createdAt, updatedAt})
//   -[:HAS_EVENT]->
// (:WorkflowEvent {eventId, workflowId, sequenceNumber, eventType, status, timestamp, payloadJson, nodeKey, actor})
