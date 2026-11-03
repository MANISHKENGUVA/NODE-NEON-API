/**
 * SQL for `workflow_sessions` — the server-side record of who is talking to an
 * application. The client only ever holds the opaque `session_id`.
 */
const { run } = require("../../db/pool");

async function create(db, { sessionId, applicationId, workflowActor, expiresAt }) {
  const result = await run(
    db,
    `INSERT INTO workflow_sessions (session_id, application_id, workflow_actor, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [sessionId, applicationId, workflowActor, expiresAt]
  );
  return result.rows[0];
}

function findById(db, sessionId) {
  return run(db, "SELECT * FROM workflow_sessions WHERE session_id = $1", [sessionId]).then(
    (result) => result.rows[0] ?? null
  );
}

/** Marks the session as belonging to an authenticated actor. */
async function markAuthenticated(db, sessionId, actorId) {
  const result = await run(
    db,
    `UPDATE workflow_sessions
        SET status = 'ACTOR_AUTHENTICATED', actor_id = $2, updated_at = now()
      WHERE session_id = $1
      RETURNING *`,
    [sessionId, actorId]
  );
  return result.rows[0] ?? null;
}

/** Records that this session solved a captcha. */
async function markCaptchaVerified(db, sessionId) {
  const result = await run(
    db,
    `UPDATE workflow_sessions
        SET captcha_verified_at = now(), updated_at = now()
      WHERE session_id = $1
      RETURNING *`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/**
 * The newest unexpired actor authentication for a session.
 *
 * A session row can still say `ACTOR_AUTHENTICATED` after its proof expired;
 * this lookup is what makes the effective state honest. `resolveToken` uses it
 * to report `ACTOR_SESSION_EXPIRED`, and `getState` checks the method-specific
 * rows before claiming a node's authentication requirement is satisfied.
 */
function findActiveAuthentication(db, sessionId) {
  return run(
    db,
    `SELECT *
       FROM actor_authentications
      WHERE session_id = $1
        AND status = 'ACTIVE'
        AND expires_at > now()
      ORDER BY verified_at DESC
      LIMIT 1`,
    [sessionId]
  ).then((result) => result.rows[0] ?? null);
}

/** Revokes a session exactly once. Returns null when it was already revoked. */
function revoke(db, sessionId) {
  return run(
    db,
    `UPDATE workflow_sessions
        SET revoked_at = now(), updated_at = now()
      WHERE session_id = $1 AND revoked_at IS NULL
      RETURNING *`,
    [sessionId]
  ).then((result) => result.rows[0] ?? null);
}

/** Removes expired sessions. Called opportunistically, never on the request path. */
async function deleteExpired(db) {
  const result = await run(db, "DELETE FROM workflow_sessions WHERE expires_at < now()");
  return result.rowCount;
}

module.exports = {
  create,
  findById,
  markAuthenticated,
  markCaptchaVerified,
  findActiveAuthentication,
  revoke,
  deleteExpired,
};
