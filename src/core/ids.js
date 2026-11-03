/**
 * Public identifiers for a loan application.
 *
 * The database primary key stays internal (uuid). Humans and support teams use
 * `application_no`, and external systems quote `workflow_id`.
 */
const crypto = require("crypto");

function datePart(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/** e.g. `LN-20261026-8F3A1C`. Random suffix keeps it unguessable. */
function newApplicationNumber() {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `LN-${datePart()}-${suffix}`;
}

/** e.g. `WF-3f2b...`. Opaque id shared with partner systems. */
function newWorkflowId() {
  return `WF-${crypto.randomUUID()}`;
}

/** Opaque session identifier stored in `workflow_sessions.session_id`. */
function newSessionId() {
  return crypto.randomUUID();
}

module.exports = { newApplicationNumber, newWorkflowId, newSessionId };
