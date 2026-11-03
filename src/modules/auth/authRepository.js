/**
 * SQL for one-time authentication challenges and the resulting actor
 * authentications.
 */
const { run } = require("../../db/pool");

async function createChallenge(
  db,
  {
    challengeId,
    sessionId,
    recoveryId,
    purpose = "SESSION",
    method,
    subjectHash,
    codeHash,
    maxAttempts,
    expiresAt,
  }
) {
  const result = await run(
    db,
    `INSERT INTO auth_challenges
       (challenge_id, session_id, recovery_id, purpose, method, subject_hash, code_hash,
        max_attempts, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      challengeId,
      sessionId ?? null,
      recoveryId ?? null,
      purpose,
      method,
      subjectHash,
      codeHash,
      maxAttempts,
      expiresAt,
    ]
  );
  return result.rows[0];
}

function findChallenge(db, challengeId) {
  return run(db, "SELECT * FROM auth_challenges WHERE challenge_id = $1", [challengeId]).then(
    (result) => result.rows[0] ?? null
  );
}

/** The newest challenge for a session that can still be verified. */
function findOpenBySession(db, sessionId) {
  return run(
    db,
    `SELECT * FROM auth_challenges
      WHERE session_id = $1
        AND consumed_at IS NULL
        AND expires_at > now()
        AND attempts < max_attempts
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId]
  ).then((result) => result.rows[0] ?? null);
}

/**
 * The newest unused recovery code for a recovery challenge.
 *
 * Expired codes are returned rather than filtered out: the caller has to say
 * "this expired" instead of "there is no code", which would send a user who
 * simply waited too long back to the request step with a misleading message.
 */
function findOpenByRecovery(db, recoveryId) {
  return run(
    db,
    `SELECT * FROM auth_challenges
      WHERE recovery_id = $1
        AND purpose = 'RECOVERY'
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [recoveryId]
  ).then((result) => result.rows[0] ?? null);
}

/** Counts a failed attempt and returns the new total. */
async function registerFailedAttempt(db, challengeId) {
  const result = await run(
    db,
    `UPDATE auth_challenges
        SET attempts = attempts + 1
      WHERE challenge_id = $1
      RETURNING attempts`,
    [challengeId]
  );
  return result.rows[0]?.attempts ?? 0;
}

/**
 * Marks a challenge used. The `consumed_at IS NULL` guard makes it single-use
 * even under concurrency: the second caller gets false and must refuse.
 */
async function consumeChallenge(db, challengeId) {
  const result = await run(
    db,
    `UPDATE auth_challenges
        SET consumed_at = now()
      WHERE challenge_id = $1 AND consumed_at IS NULL`,
    [challengeId]
  );
  return result.rowCount > 0;
}

async function createAuthentication(db, { sessionId, actorId, method, subjectHash, expiresAt }) {
  const result = await run(
    db,
    `INSERT INTO actor_authentications
       (session_id, actor_id, method, subject_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [sessionId, actorId, method, subjectHash, expiresAt]
  );
  return result.rows[0];
}

/** Most recent active authentication for a session and method. */
function findActiveAuthentication(db, sessionId, method) {
  return run(
    db,
    `SELECT * FROM actor_authentications
      WHERE session_id = $1 AND method = $2 AND status = 'ACTIVE' AND expires_at > now()
      ORDER BY verified_at DESC
      LIMIT 1`,
    [sessionId, method]
  ).then((result) => result.rows[0] ?? null);
}

module.exports = {
  createChallenge,
  findChallenge,
  findOpenBySession,
  findOpenByRecovery,
  registerFailedAttempt,
  consumeChallenge,
  createAuthentication,
  findActiveAuthentication,
};
