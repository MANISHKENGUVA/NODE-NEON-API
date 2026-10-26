/**
 * challengeStore.js
 *
 * Server-side store for authentication challenges (OTP style flows).
 *
 * - The numeric code is generated on the BACKEND with a CSPRNG.
 * - Only sha256(challengeId:code) is persisted — the code never hits the DB.
 * - Challenges are single-use, expire, and are attempt-limited.
 * - Verification always happens server-side; the frontend only relays.
 */

const crypto = require("crypto");
const { sql } = require("../config/db");

function hashChallengeCode(code, challengeId) {
  return crypto
    .createHash("sha256")
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

function generateNumericCode(length = 6) {
  return String(crypto.randomInt(0, 10 ** length)).padStart(length, "0");
}

/**
 * Creates a new challenge.
 *
 * @param   {object} params
 * @param   {string} params.method
 * @param   {string} params.subjectHash
 * @param   {number} params.ttlSeconds
 * @param   {string} [params.sessionId]
 * @returns {Promise<{challengeId: string, code: string, expiresAt: Date}>}
 */
async function createChallenge({ method, subjectHash, ttlSeconds, sessionId = null }) {
  const challengeId = crypto.randomUUID();
  const code = generateNumericCode(6);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  await sql`
    INSERT INTO auth_challenges
      (challenge_id, session_id, method, subject_hash, code_hash, attempts, max_attempts, created_at, expires_at)
    VALUES
      (${challengeId}, ${sessionId}, ${method}, ${subjectHash},
       ${hashChallengeCode(code, challengeId)}, 0, 5, ${now}, ${expiresAt})
  `;

  return { challengeId, code, expiresAt };
}

/**
 * Verifies a code against a stored challenge and consumes it on success.
 *
 * @param   {object} params
 * @param   {string} params.challengeId
 * @param   {string} params.code
 * @param   {string} params.method
 * @returns {Promise<{ok: boolean, reason?: string, subjectHash?: string}>}
 */
async function verifyChallenge({ challengeId, code, method }) {
  const rows = await sql`
    SELECT * FROM auth_challenges
    WHERE challenge_id = ${challengeId}
    LIMIT 1
  `;

  const row = rows && rows[0];
  if (!row) return { ok: false, reason: "INVALID_CHALLENGE" };

  if (row.method !== method) return { ok: false, reason: "METHOD_MISMATCH" };
  if (row.consumed_at) return { ok: false, reason: "CHALLENGE_ALREADY_USED" };
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: "CHALLENGE_EXPIRED" };
  }
  if (row.attempts >= row.max_attempts) {
    return { ok: false, reason: "TOO_MANY_ATTEMPTS" };
  }

  const expected = String(code);
  const computed = hashChallengeCode(expected, challengeId);
  const a = Buffer.from(computed);
  const b = Buffer.from(String(row.code_hash));
  const matches = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!matches) {
    await sql`
      UPDATE auth_challenges
      SET attempts = attempts + 1
      WHERE challenge_id = ${challengeId}
    `;
    return { ok: false, reason: "INVALID_CODE" };
  }

  const consumed = await sql`
    UPDATE auth_challenges
    SET consumed_at = NOW(), attempts = attempts + 1
    WHERE challenge_id = ${challengeId} AND consumed_at IS NULL
    RETURNING challenge_id
  `;

  if (!consumed || consumed.length === 0) {
    return { ok: false, reason: "CHALLENGE_ALREADY_USED" };
  }

  return { ok: true, subjectHash: row.subject_hash };
}

module.exports = { createChallenge, verifyChallenge };
