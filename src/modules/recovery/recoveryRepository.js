/**
 * SQL for `workflow_recovery_challenges`.
 *
 * The interesting parts are the conditional updates: consuming a challenge and
 * counting a failed attempt both happen in a single statement so two concurrent
 * requests cannot both succeed.
 */
const { run } = require("../../db/pool");

async function create(
  db,
  {
    recoveryId,
    applicationId,
    workflowId,
    workflowActor,
    requiredMethods,
    maxAttempts,
    expiresAt,
  }
) {
  const result = await run(
    db,
    `INSERT INTO workflow_recovery_challenges
       (recovery_id, application_id, workflow_id, workflow_actor,
        required_methods, max_attempts, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      recoveryId,
      applicationId,
      workflowId,
      workflowActor,
      requiredMethods,
      maxAttempts,
      expiresAt,
    ]
  );
  return result.rows[0];
}

function findById(db, recoveryId) {
  return run(
    db,
    "SELECT * FROM workflow_recovery_challenges WHERE recovery_id = $1",
    [recoveryId]
  ).then((result) => result.rows[0] ?? null);
}

/** Takes a row lock; the caller must already be inside a transaction. */
function lockById(db, recoveryId) {
  return run(
    db,
    "SELECT * FROM workflow_recovery_challenges WHERE recovery_id = $1 FOR UPDATE",
    [recoveryId]
  ).then((result) => result.rows[0] ?? null);
}

/**
 * A challenge that is still usable for this application and actor.
 *
 * Reusing it instead of creating another means a reload in the middle of
 * recovery does not reset the attempt counter — which would otherwise be a
 * trivial way to get unlimited OTP guesses.
 */
function findPending(db, applicationId, workflowActor) {
  return run(
    db,
    `SELECT * FROM workflow_recovery_challenges
      WHERE application_id = $1
        AND workflow_actor = $2
        AND status = 'PENDING'
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [applicationId, workflowActor]
  ).then((result) => result.rows[0] ?? null);
}

/** Starts for one application inside a window — the rate limit. */
function countStartsSince(db, applicationId, since) {
  return run(
    db,
    `SELECT count(*)::int AS total
       FROM workflow_recovery_challenges
      WHERE application_id = $1 AND created_at >= $2`,
    [applicationId, since]
  ).then((result) => result.rows[0]?.total ?? 0);
}

async function markCaptchaVerified(db, recoveryId) {
  await run(
    db,
    `UPDATE workflow_recovery_challenges
        SET captcha_verified_at = now(), updated_at = now()
      WHERE recovery_id = $1`,
    [recoveryId]
  );
}

async function markOtpVerified(db, recoveryId) {
  await run(
    db,
    `UPDATE workflow_recovery_challenges
        SET otp_verified_at = now(), updated_at = now()
      WHERE recovery_id = $1`,
    [recoveryId]
  );
}

/**
 * One send, and a timestamp the resend throttle can read.
 *
 * The `otp_sends < $2` guard makes the cap authoritative even if two requests
 * arrive together.
 */
function registerOtpSend(db, recoveryId, maxSends) {
  return run(
    db,
    `UPDATE workflow_recovery_challenges
        SET otp_sends = otp_sends + 1, otp_last_sent_at = now(), updated_at = now()
      WHERE recovery_id = $1 AND otp_sends < $2
      RETURNING otp_sends, otp_last_sent_at`,
    [recoveryId, maxSends]
  ).then((result) => result.rows[0] ?? null);
}

/**
 * Counts a wrong code and locks the challenge once the budget is spent.
 * Returns the new counters so the caller can report what is left.
 */
function registerFailedAttempt(db, recoveryId, lockoutMinutes) {
  return run(
    db,
    `UPDATE workflow_recovery_challenges
        SET attempts = attempts + 1,
            locked_until = CASE
              WHEN attempts + 1 >= max_attempts
                THEN now() + make_interval(mins => $2)
              ELSE locked_until
            END,
            updated_at = now()
      WHERE recovery_id = $1
      RETURNING attempts, max_attempts, locked_until`,
    [recoveryId, lockoutMinutes]
  ).then((result) => result.rows[0] ?? null);
}

/**
 * Consumes the challenge exactly once.
 *
 * Returns null when another request already consumed it, so completion can be
 * refused without a second read.
 */
function consume(db, recoveryId, sessionId) {
  return run(
    db,
    `UPDATE workflow_recovery_challenges
        SET status = 'COMPLETED', consumed_at = now(), session_id = $2, updated_at = now()
      WHERE recovery_id = $1
        AND status = 'PENDING'
        AND consumed_at IS NULL
      RETURNING *`,
    [recoveryId, sessionId ?? null]
  ).then((result) => result.rows[0] ?? null);
}

/**
 * The contact details a recovery may rely on — never returned to the client.
 *
 * The actor is part of the key: a co-borrower recovery must prove the
 * co-borrower's own number, not the borrower's. Joining the wrong party would
 * send the code to somebody else while claiming the claimant was verified.
 */
function findContact(db, applicationId, workflowActor = "BORROWER") {
  return run(
    db,
    `SELECT CASE
              WHEN ap.mobile_verified_at IS NOT NULL THEN ap.mobile_number
              ELSE NULL
            END AS mobile_number,
            ap.aadhaar_hash IS NOT NULL AS has_aadhaar,
            ap.aadhaar_last4
       FROM loan_applications l
       JOIN applicants ap
         ON ap.id = CASE
              WHEN $2 = 'COBORROWER' THEN l.coborrower_id
              ELSE l.borrower_id
            END
      WHERE l.id = $1`,
    [applicationId, String(workflowActor).toUpperCase()]
  ).then((result) => result.rows[0] ?? null);
}

module.exports = {
  create,
  findById,
  lockById,
  findPending,
  countStartsSince,
  markCaptchaVerified,
  markOtpVerified,
  registerOtpSend,
  registerFailedAttempt,
  consume,
  findContact,
};
