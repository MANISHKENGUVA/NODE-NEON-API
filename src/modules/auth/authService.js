/**
 * One-time authentication challenges for flow nodes that require them.
 *
 * Two methods exist in this workflow version:
 *
 *   MOBILE_OTP — a six digit code sent to the applicant's mobile number.
 *   AADHAAR    — a six digit code tied to the Aadhaar number on file.
 *
 * A challenge is single use, expires quickly, and locks after five wrong
 * attempts. A successful verification writes an `actor_authentications` row
 * that the workflow checks before letting the actor complete the node.
 *
 * Delivery is intentionally pluggable but *not* implemented here: without an
 * SMS/UIDAI gateway the code is only returned when `AUTH_DEV_MODE=true`,
 * which `validateConfig()` refuses in production.
 */
const crypto = require("crypto");
const { config } = require("../../config/env");
const { withTransaction } = require("../../db/pool");
const { sha256, hashIdentifier } = require("../../core/hash");
const { AppError, badRequest, conflict, forbidden, unauthorized } = require("../../core/errors");
const { patterns, requireMatch, requireString } = require("../../core/validation");
const repository = require("./authRepository");
const sessionRepository = require("../session/sessionRepository");
const applicationRepository = require("../application/applicationRepository");
const applicantRepository = require("../applicant/applicantRepository");

const AUTH_METHODS = Object.freeze({ MOBILE_OTP: "MOBILE_OTP", AADHAAR: "AADHAAR" });
const MAX_ATTEMPTS = 5;
const AADHAAR_NUMBER = /^[0-9]{12}$/;

function normaliseMethod(value) {
  const method = requireString(value, "method", { max: 20 }).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(AUTH_METHODS, method)) {
    throw badRequest(
      "UNSUPPORTED_AUTH_METHOD",
      `'method' must be one of: ${Object.keys(AUTH_METHODS).join(", ")}`
    );
  }
  return method;
}

/** The subject is the number the code is delivered to; only its digest is kept. */
function readSubject(method, value) {
  if (method === AUTH_METHODS.MOBILE_OTP) {
    return requireMatch(value, "mobileNumber", patterns.MOBILE, "'mobileNumber' must be a 10 digit Indian mobile number");
  }
  return requireMatch(value, "aadhaarNumber", AADHAAR_NUMBER, "'aadhaarNumber' must be 12 digits");
}

function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function digestCode(challengeId, code) {
  return sha256(`challenge:${challengeId}:${code}`);
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left), "hex");
  const b = Buffer.from(String(right), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function expiryDate(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * The subject must belong to the person the session already represents.
 *
 * Without this, a borrower could ask the server to send a code to any mobile
 * number (or verify any Aadhaar) and then mark their own session authenticated
 * with somebody else's identity. Staff actors have no applicant row; the
 * existing staff fallback is preserved for them.
 */
async function assertSubjectBelongsToSession(db, session, method, subjectValue) {
  if (session.actor !== "BORROWER" && session.actor !== "COBORROWER") return;

  const application = await applicationRepository.findById(db, session.applicationId);
  if (!application) throw conflict("APPLICATION_NOT_FOUND", "Application not found");

  const applicantId =
    session.actor === "BORROWER" ? application.borrower_id : application.coborrower_id;
  const applicant = applicantId
    ? await applicantRepository.findApplicantById(db, applicantId)
    : null;

  if (!applicant) {
    throw conflict(
      "AUTH_SUBJECT_UNAVAILABLE",
      `No ${session.actor.toLowerCase()} applicant is on file yet`
    );
  }

  if (method === AUTH_METHODS.MOBILE_OTP) {
    if (!applicant.mobile_number) {
      throw conflict("AUTH_SUBJECT_UNAVAILABLE", "No mobile number is on file for this applicant");
    }
    if (String(applicant.mobile_number) !== subjectValue) {
      throw new AppError(
        403,
        "AUTH_SUBJECT_MISMATCH",
        "The mobile number does not belong to this applicant"
      );
    }
    return;
  }

  if (!applicant.aadhaar_hash) {
    throw conflict("AUTH_SUBJECT_UNAVAILABLE", "No Aadhaar number is on file for this applicant");
  }
  if (hashIdentifier(subjectValue) !== applicant.aadhaar_hash) {
    throw new AppError(
      403,
      "AUTH_SUBJECT_MISMATCH",
      "The Aadhaar number does not belong to this applicant"
    );
  }
}

/**
 * Creates a challenge for the session's actor.
 *
 * @returns {{challengeId: string, method: string, expiresAt: Date, code?: string}}
 */
async function start({ db, session, method: rawMethod, subject }) {
  const method = normaliseMethod(rawMethod);
  const subjectValue = readSubject(method, subject);
  await assertSubjectBelongsToSession(db, session, method, subjectValue);

  if (!config.auth.devMode) {
    throw new AppError(
      503,
      "AUTH_DELIVERY_UNAVAILABLE",
      "No authentication delivery provider is configured"
    );
  }

  const challengeId = crypto.randomUUID();
  const code = generateCode();
  const expiresAt = expiryDate(config.session.challengeTtlMinutes);

  await repository.createChallenge(db, {
    challengeId,
    sessionId: session.sessionId,
    method,
    // Subject and code are never stored in clear text.
    subjectHash: sha256(`subject:${subjectValue}`),
    codeHash: digestCode(challengeId, code),
    maxAttempts: MAX_ATTEMPTS,
    expiresAt,
  });

  // Dev only (`AUTH_DEV_MODE` is refused in production). The code is returned
  // so a script can use it directly; it is never logged.
  return { challengeId, method, expiresAt, delivery: "RESPONSE", code };
}

/** Verifies a code and records the resulting authentication. */
async function verify({ db, session, challengeId, code }) {
  const outcome = await withTransaction(async (tx) => {
    const challenge = await repository.findChallenge(tx, challengeId);
    if (!challenge) throw unauthorized("Unknown authentication challenge");

    if (challenge.session_id !== session.sessionId) {
      throw forbidden("This challenge belongs to another session");
    }
    if (challenge.consumed_at) throw conflict("CHALLENGE_USED", "This challenge was already used");
    if (new Date(challenge.expires_at).getTime() <= Date.now()) {
      throw conflict("CHALLENGE_EXPIRED", "This challenge has expired");
    }
    if (challenge.attempts >= challenge.max_attempts) {
      throw conflict("CHALLENGE_LOCKED", "Too many incorrect attempts on this challenge");
    }

    const submitted = requireString(code, "code", { max: 10 });
    if (!safeEqualHex(digestCode(challenge.challenge_id, submitted), challenge.code_hash)) {
      const attempts = await repository.registerFailedAttempt(tx, challenge.challenge_id);
      const remaining = Math.max(challenge.max_attempts - attempts, 0);
      return {
        failure: unauthorized(
          remaining > 0
            ? `Incorrect code, ${remaining} attempt${remaining === 1 ? "" : "s"} left`
            : "Incorrect code, this challenge is now locked"
        ),
      };
    }

    if (
      challenge.method === AUTH_METHODS.MOBILE_OTP &&
      ["BORROWER", "COBORROWER"].includes(session.actor)
    ) {
      const application = await applicationRepository.findById(tx, session.applicationId);
      const applicantId =
        session.actor === "BORROWER"
          ? application?.borrower_id
          : application?.coborrower_id;
      const applicant = applicantId
        ? await applicantRepository.findApplicantById(tx, applicantId)
        : null;
      if (
        !applicant?.mobile_number ||
        sha256(`subject:${applicant.mobile_number}`) !== challenge.subject_hash
      ) {
        throw conflict(
          "AUTH_SUBJECT_CHANGED",
          "The applicant's mobile number changed after this challenge was issued"
        );
      }

      const marked = await applicantRepository.markMobileVerified(
        tx,
        applicantId,
        applicant.mobile_number
      );
      if (!marked) {
        throw conflict("AUTH_SUBJECT_CHANGED", "The applicant's mobile number has changed");
      }
    }

    // The verification, authentication record and actor promotion commit
    // together, so a failed write cannot consume a valid code permanently.
    const consumed = await repository.consumeChallenge(tx, challenge.challenge_id);
    if (!consumed) {
      throw conflict("CHALLENGE_USED", "This challenge was already used");
    }

    const authentication = await repository.createAuthentication(tx, {
      sessionId: session.sessionId,
      actorId: session.actor,
      method: challenge.method,
      subjectHash: challenge.subject_hash,
      expiresAt: expiryDate(config.session.actorTtlMinutes),
    });

    await sessionRepository.markAuthenticated(tx, session.sessionId, session.actor);

    return {
      value: {
        method: authentication.method,
        verifiedAt: authentication.verified_at,
        expiresAt: authentication.expires_at,
      },
    };
  });

  if (outcome.failure) throw outcome.failure;
  return outcome.value;
}

module.exports = {
  AUTH_METHODS,
  normaliseMethod,
  start,
  verify,
  // Shared with the recovery flow, which issues the same kind of one-time code
  // for a different owner. Exporting beats duplicating the digest format, where
  // a divergence would be a silent security bug.
  generateCode,
  digestCode,
  safeEqualHex,
};
