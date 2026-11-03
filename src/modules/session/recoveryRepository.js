/**
 * SQL for `application_recovery_tokens`. Only the digest is ever stored.
 */
const { run } = require("../../db/pool");

async function create(db, { tokenHash, applicationId, workflowActor, expiresAt }) {
  const result = await run(
    db,
    `INSERT INTO application_recovery_tokens
       (token_hash, application_id, workflow_actor, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tokenHash, applicationId, workflowActor, expiresAt]
  );
  return result.rows[0];
}

/** A token that is neither revoked nor expired. */
function findLive(db, tokenHash) {
  return run(
    db,
    `SELECT * FROM application_recovery_tokens
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()`,
    [tokenHash]
  ).then((result) => result.rows[0] ?? null);
}

async function touch(db, tokenHash) {
  await run(
    db,
    "UPDATE application_recovery_tokens SET last_used_at = now() WHERE token_hash = $1",
    [tokenHash]
  );
}

async function revoke(db, tokenHash) {
  await run(
    db,
    `UPDATE application_recovery_tokens
        SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}

module.exports = { create, findLive, touch, revoke };
