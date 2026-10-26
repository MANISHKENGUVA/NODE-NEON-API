/**
 * sessionManager.js
 *
 * Authoritative store for WORKFLOW SESSIONS and ACTOR SESSIONS.
 *
 * A workflow session is created when a user starts a workflow. It may be
 * ANONYMOUS and is always a valid workflow session for PUBLIC nodes — actor
 * authentication is NOT required at session creation.
 *
 * After a successful server-side authentication the same workflow session is
 * associated with an authenticated actor session (a separate record with its
 * own, usually shorter, expiry):
 *
 *   ANONYMOUS → AUTHENTICATE → ACTOR_AUTHENTICATED
 *
 * Expiry rules are independent:
 *   - workflow session expired → SESSION_EXPIRED (frontend restarts/recovers)
 *   - actor session expired    → AUTHENTICATION_REQUIRED on ACTOR nodes only;
 *     the workflow journey itself stays valid unless business config says so.
 *
 * TTLs (minutes, overridable via env):
 *   WORKFLOW_SESSION_TTL_MINUTES (default 720) — workflow journey (longer)
 *   ACTOR_SESSION_TTL_MINUTES    (default 30)  — authentication  (shorter)
 *   AUTH_CHALLENGE_TTL_MINUTES   (default 5)   — OTP challenges
 */

const crypto = require("crypto");
const { sql } = require("../config/db");
const {
  generateWorkflowIdentifier,
  createWorkIdentifierRecord,
} = require("../services/workflowIdentifier");

// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — TTL configuration helpers
// ═════════════════════════════════════════════════════════════════════════════

function ttlMinutes(envName, defaultMinutes) {
  const raw = parseFloat(process.env[envName]);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMinutes;
}

function workflowSessionTtlMinutes() {
  return ttlMinutes("WORKFLOW_SESSION_TTL_MINUTES", 720);
}

function actorSessionTtlMinutes() {
  return ttlMinutes("ACTOR_SESSION_TTL_MINUTES", 30);
}

function challengeTtlSeconds() {
  return Math.round(ttlMinutes("AUTH_CHALLENGE_TTL_MINUTES", 5) * 60);
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — Pure helpers
// ═════════════════════════════════════════════════════════════════════════════

function generateSessionId() {
  return `SES-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Public DTO for a workflow session row — never leaks DB internals.
 *
 * @param   {object} row        workflow_sessions row
 * @param   {object} [authRow]  active actor_sessions row (if any)
 * @returns {object}
 */
function serializeSession(row, authRow = null) {
  const dto = {
    sessionId: row.session_id,
    workflowId: row.workflow_id,
    status: row.status,
    workflowActor: row.workflow_actor,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
  };

  if (row.actor_id) dto.actorId = row.actor_id;

  if (authRow) {
    dto.authentication = {
      method: authRow.method,
      verifiedAt: toIso(authRow.verified_at),
      expiresAt: toIso(authRow.expires_at),
    };
  }

  return dto;
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — Workflow session data access
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Creates an ANONYMOUS workflow session.
 *
 * Also guarantees the backing workflow record exists so the resolution
 * pipeline (latest event → rule engine → node) can run immediately.
 *
 * `ttlMinutes` may only shorten the configured workflow-session TTL —
 * clients can never extend it.
 *
 * @param   {object} [input]
 * @param   {string} [input.workflowId]     — continue an existing workflow
 * @param   {string} [input.workflowActor]  — default actor role ("BORROWER")
 * @param   {number} [input.ttlMinutes]     — optional shorter TTL
 * @returns {Promise<object>} serialized session (status ANONYMOUS)
 */
async function createWorkflowSession({ workflowId, workflowActor, ttlMinutes } = {}) {
  const targetWorkflowId = workflowId || generateWorkflowIdentifier();
  const actor = workflowActor || "BORROWER";

  // Ensure the workflow journey record exists (reuses the existing
  // work_identifiers creation path — no duplicate implementation).
  const existing = await sql`
    SELECT workflow_id FROM work_identifiers
    WHERE workflow_id = ${targetWorkflowId}
    LIMIT 1
  `;

  if (!existing || existing.length === 0) {
    await createWorkIdentifierRecord({
      workflow_id: targetWorkflowId,
      events: { states: [], currentState: null },
    });
  }

  const configuredTtl = workflowSessionTtlMinutes();
  let effectiveTtl = configuredTtl;
  const requestedTtl = parseFloat(ttlMinutes);
  if (Number.isFinite(requestedTtl) && requestedTtl > 0) {
    // Clamp: shorter than configured default, never shorter than 3 seconds.
    effectiveTtl = Math.min(Math.max(requestedTtl, 0.05), configuredTtl);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + effectiveTtl * 60 * 1000);
  const sessionId = generateSessionId();

  const [row] = await sql`
    INSERT INTO workflow_sessions
      (session_id, workflow_id, workflow_actor, status, created_at, expires_at, updated_at)
    VALUES
      (${sessionId}, ${targetWorkflowId}, ${actor}, 'ANONYMOUS', ${now}, ${expiresAt}, ${now})
    RETURNING *
  `;

  return serializeSession(row);
}

/**
 * Loads a workflow session and validates expiry.
 *
 * Unknown session ids are reported exactly like expired ones
 * (SESSION_EXPIRED) so the frontend has a single restart path.
 *
 * @param   {string} sessionId
 * @returns {Promise<{ok: true, session: object} | {ok: false, status: string}>}
 */
async function loadSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    return { ok: false, status: "SESSION_EXPIRED" };
  }

  const rows = await sql`
    SELECT * FROM workflow_sessions
    WHERE session_id = ${sessionId}
    LIMIT 1
  `;

  const row = rows && rows[0];
  if (!row) return { ok: false, status: "SESSION_EXPIRED" };

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: "SESSION_EXPIRED" };
  }

  return { ok: true, session: row };
}

/**
 * Returns the serialized session (with active authentication info when
 * present), or null when unknown/expired.
 *
 * When the workflow session is still valid but the actor authentication has
 * expired, the DTO reports the EFFECTIVE status: the session behaves as
 * ANONYMOUS again (the workflow journey itself remains valid).
 *
 * @param   {string} sessionId
 * @returns {Promise<object|null>}
 */
async function getSessionResponse(sessionId) {
  const loaded = await loadSession(sessionId);
  if (!loaded.ok) return null;

  const row = loaded.session;
  const auth = await getActorAuthentication(row.session_id);

  if (auth.expired || !auth.session) {
    const effective = { ...row };
    if (effective.status === "ACTOR_AUTHENTICATED") {
      effective.status = "ANONYMOUS";
      effective.actor_id = null; // authentication no longer valid
    }
    return serializeSession(effective, null);
  }

  return serializeSession(row, auth.session);
}

// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — Actor session data access
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Latest actor authentication attached to a workflow session.
 *
 * @param   {string} sessionId
 * @returns {Promise<{session: object|null, expired: boolean}>}
 */
async function getActorAuthentication(sessionId) {
  const rows = await sql`
    SELECT * FROM actor_sessions
    WHERE session_id = ${sessionId}
    ORDER BY verified_at DESC
    LIMIT 1
  `;

  const row = rows && rows[0];
  if (!row) return { session: null, expired: false };

  const expired =
    row.status !== "ACTIVE" || new Date(row.expires_at).getTime() <= Date.now();

  return { session: row, expired };
}

/**
 * Creates the actor authentication session and associates the actor with the
 * workflow session (ANONYMOUS → ACTOR_AUTHENTICATED).
 *
 * @param   {object} params
 * @param   {string} params.sessionId
 * @param   {string} params.actorId
 * @param   {string} params.method      — e.g. "AADHAAR", "MOBILE_OTP"
 * @param   {string} params.subjectHash — non-reversible subject reference
 * @returns {Promise<{row: object, expiresAt: Date}>}
 */
async function attachActorAuthentication({ sessionId, actorId, method, subjectHash }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + actorSessionTtlMinutes() * 60 * 1000);

  const [authRow] = await sql`
    INSERT INTO actor_sessions
      (session_id, actor_id, method, subject_hash, verified_at, expires_at, status, created_at)
    VALUES
      (${sessionId}, ${actorId}, ${method}, ${subjectHash}, ${now}, ${expiresAt}, 'ACTIVE', ${now})
    RETURNING *
  `;

  await sql`
    UPDATE workflow_sessions
    SET status = 'ACTOR_AUTHENTICATED',
        actor_id = ${actorId},
        updated_at = NOW()
    WHERE session_id = ${sessionId}
  `;

  return { row: authRow, expiresAt };
}

module.exports = {
  // TTL helpers (shared with authentication providers)
  workflowSessionTtlMinutes,
  actorSessionTtlMinutes,
  challengeTtlSeconds,

  // Workflow sessions
  createWorkflowSession,
  loadSession,
  getSessionResponse,

  // Actor sessions
  getActorAuthentication,
  attachActorAuthentication,

  // Exported for reuse/tests
  generateSessionId,
  serializeSession,
};


