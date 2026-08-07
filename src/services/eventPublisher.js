// eventPublisher.js
const { sql } = require("../config/db");

class EVENTPUB {
  /**
   * Builds, publishes and appends a STATE_TRANSITION event into events.states[] in the DB.
   * states is an ARRAY — every call appends a new entry, never overwrites.
   *
   * @param {object} params
   * @param {string} params.workflowId
   * @param {string} params.actor
   * @param {string} params.eventName      - state key e.g. "BORROWER-DETAILS-V1-PERSONAL-INFO-V1"
   * @param {object} params.metadata       - { actor, module, moduleVersion, node, nodeVersion }
   * @param {object} params.workflowEvents - current events object from DB (events column)
   */
  async publish({ workflowId, actor, eventName, metadata, workflowEvents }) {
    const event = {
      eventType:  "STATE_TRANSITION",
      workflowId,
      actor,
      eventName,
      metadata: {
        actor:         metadata.actor,
        module:        metadata.module,
        moduleVersion: metadata.moduleVersion,
        node:          metadata.node,
        nodeVersion:   metadata.nodeVersion,
      },
      timestamp: new Date().toISOString(),
    };

    console.log("[EVENTPUB] Publishing event:", JSON.stringify(event, null, 2));

    // states is an array — append the new event, never overwrite
    const existingStates = Array.isArray(workflowEvents?.states)
      ? workflowEvents.states
      : [];

    const updatedEvents = {
      ...workflowEvents,
      states:       [...existingStates, event],
      currentState: eventName,   // track the latest node for quick lookup
    };

    await sql`
      UPDATE work_identifiers
      SET events     = ${JSON.stringify(updatedEvents)},
          updated_at = NOW()
      WHERE workflow_id = ${workflowId}
    `;

    console.log(`[EVENTPUB] Event appended. Total states recorded: ${updatedEvents.states.length}`);

    return event;
  }
}

module.exports = new EVENTPUB();
