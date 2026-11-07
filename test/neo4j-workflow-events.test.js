# Workflow Event Graph Architecture

This repository keeps PostgreSQL as the transactional source of truth for workflow state and uses Neo4j as an optional graph projection for workflow event history.

## Graph model

```
(:Workflow {
  workflowId: "WF-...",
  status: "IN_PROGRESS",
  createdAt: datetime(),
  updatedAt: datetime()
})
  -[:HAS_EVENT]->
(:WorkflowEvent {
  eventId: "WF-...-1",
  workflowId: "WF-...",
  sequenceNumber: 1,
  eventType: "STEP_COMPLETED",
  stepNumber: 1,
  status: "COMPLETED",
  timestamp: datetime(),
  payloadJson: "{\"ok\":true}",
  nodeKey: "BORROWER-DETAILS-V1-PERSONAL-INFO-V1",
  actor: "BORROWER"
})
```

## Neo4j setup

Set these env vars before enabling Neo4j:

```bash
NEO4J_ENABLED=true
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your-password
```

## Constraints and indexes

See `src/neo4j/workflowEventRepository.js` for the runtime constraints and indexes created by `ensureSchema()`.

## Notes

- The app still runs when Neo4j is disabled.
- Workflow state remains in PostgreSQL.
- Event projection is optional and idempotent.
