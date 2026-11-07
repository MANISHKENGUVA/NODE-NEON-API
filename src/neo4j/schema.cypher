const test = require("node:test");
const assert = require("node:assert/strict");
const repo = require("../src/neo4j/workflowEventRepository");

test("normaliseEvent keeps workflow and event metadata intact", () => {
  const event = repo.normaliseEvent("WF-test-123", {
    eventType: "STEP_COMPLETED",
    stepNumber: 2,
    status: "COMPLETED",
    nodeKey: "B-STEP-2",
    actor: "BORROWER",
    payload: { ok: true },
    fromNode: "B-STEP-1",
    toNode: "B-STEP-2",
    edgeId: "EDGE-2",
  }, 2);

  assert.equal(event.workflowId, "WF-test-123");
  assert.equal(event.sequenceNumber, 2);
  assert.equal(event.eventType, "STEP_COMPLETED");
  assert.equal(event.status, "COMPLETED");
  assert.equal(event.nodeKey, "B-STEP-2");
  assert.equal(event.actor, "BORROWER");
  assert.deepEqual(JSON.parse(event.payloadJson), { ok: true });
});

test("normaliseEvent creates a stable event id when none is provided", () => {
  const event = repo.normaliseEvent("WF-custom", { eventType: "WORKFLOW_STARTED" }, 1);
  assert.equal(event.eventId, "WF-custom-1");
});
