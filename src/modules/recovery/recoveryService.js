/**
 * Recovering an existing application when the browser has no session.
 *
 * This is the *second* recovery path. The first (003+`recoveryService` in
 * `modules/session`) resumes silently because the browser still holds an
 * HttpOnly credential. This one is for when that credential is gone too: the
 * claimant must prove ownership before any session is minted.
 *
 * The rules that keep it safe:
 *
 *   - A `workflowId` from the URL is a *request*, never proof. It only selects
 *     which application the claimant is asking about.
 *   - CAPTCHA is an anti-automation gate. It is never counted as proof of
 *     ownership; a challenge that ends up with only CAPTCHA required is refused.
 *   - Every factor is verified server-side, and `complete` re-checks all of them
 *     inside one transaction before consuming the challenge.
 *   - Unknown workflow, wrong factor and "not yours" collapse into one generic
 *     answer so the endpoint cannot be used to enumerate applications.
 */
const crypto = require("crypto");
const { config } = require("../../config/env");
const { withTransaction, getPool } = require("../../db/pool");
const { sha256 } = require("../../core/hash");
const { requireString } = require("../../core/validation");
const {
  AppError,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
} = require("../../core/errors");
const { listActors } = require("../../workflow/definition");
const applicationRepository = require("../application/applicationRepository");
const sessionService = require("../session/sessionService");
const authRepository = require("../auth/authRepository");
const authService = require("../auth/authService");
const captcha = require("../captcha/captchaService");
const workflowService = require("../../workflow/workflowService");
const repository = require("./recoveryRepository");

const WORKFLOW_ID = /^WF-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the parties a browser can legitimately be. Staff need the admin key. */
const RECOVERABLE_ACTORS = Object.freeze(["BORROWER", "COBORROWER"]);

const CAPTCHA_FACTOR = "CAPTCHA";
const OTP_FACTOR = "MOBILE_OTP";
const IDENTITY_FACTOR = "AADHAAR";

/** Which column proves each factor. Order also drives `nextStep`. */
const FACTOR_COLUMN = Object.freeze({
  [CAPTCHA_FACTOR]: "captcha_verified_at",
  [OTP_FACTOR]: "otp_verified_at",
  [IDENTITY_FACTOR]: "identity_verified_at",
});

const unavailable = () =>
  new AppError(503, "RECOVERY_UNAVAILABLE", "Session recovery is not available");

const invalidId = (field) =>
  new AppError(
    400,
    `INVALID_${field.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`,
    `'${field}' is not a valid identifier`
  );

/**
 * Methods this deployment can actually perform right now.
 *
 * Identity is absent by design: no provider is wired up, and a method that
 * cannot be verified must not appear as available (nor be simulated).
 */
function availableMethods() {
  const methods = [];
  const otpDeliverable =
    config.recovery.otpEnabled &&
    (config.recovery.smsProvider === "dev" || config.auth.devMode);
  if (otpDeliverable) methods.push(OTP_FACTOR);
  return methods;
}

/** The spec's name for "asked for identity, but nothing can verify it". */
const identityUnavailable = () =>
  new AppError(
    503,
    "IDENTITY_PROVIDER_UNAVAILABLE",
    "Identity verification is required by policy but no provider is configured"
  );

/**
 * What this particular application must prove.
 *
 * CAPTCHA is required whenever the policy enables it, but it is not ownership —
 * `start` refuses a challenge whose only requirement would be CAPTCHA.
 */
function requiredMethodsFor(contact) {
  const required = [];
  if (config.recovery.captchaEnabled) required.push(CAPTCHA_FACTOR);

  if (availableMethods().includes(OTP_FACTOR)) {
    const hasNumber = Boolean(contact?.mobile_number);
    if (hasNumber || !config.recovery.requireRegisteredMobile) required.push(OTP_FACTOR);
  }

  // Recorded as required even though nothing can verify it: `start` refuses
  // below rather than treating an unconfigured provider as a passed check.
  if (config.recovery.requireIdentity) required.push(IDENTITY_FACTOR);

  return required;
}

function hasOwnershipFactor(required) {
  return required.some((factor) => factor !== CAPTCHA_FACTOR);
}

function expiryDate(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function missingFactors(challenge) {
  return (challenge.required_methods ?? []).filter(
    (factor) => !challenge[FACTOR_COLUMN[factor]]
  );
}

function nextStep(challenge) {
  if (missingFactors(challenge).length === 0) return "COMPLETE";
  const required = challenge.required_methods ?? [];
  if (!challenge.captcha_verified_at && required.includes(CAPTCHA_FACTOR)) return CAPTCHA_FACTOR;
  if (!challenge.otp_verified_at && required.includes(OTP_FACTOR)) return OTP_FACTOR;
  return "COMPLETE";
}

/** Refuses a challenge that can no longer be used, whatever the reason. */
function assertUsable(challenge) {
  if (challenge.consumed_at || challenge.status === "COMPLETED") {
    throw conflict("RECOVERY_ALREADY_COMPLETED", "This recovery has already been completed");
  }
  if (challenge.status !== "PENDING") {
    throw conflict("RECOVERY_NOT_ACTIVE", "This recovery is no longer active");
  }
  if (new Date(challenge.expires_at).getTime() <= Date.now()) {
    throw conflict("RECOVERY_CHALLENGE_EXPIRED", "This recovery challenge has expired");
  }
  if (challenge.locked_until && new Date(challenge.locked_until).getTime() > Date.now()) {
    throw new AppError(
      429,
      "RECOVERY_ATTEMPTS_EXCEEDED",
      "Too many incorrect attempts; try again later"
    );
  }
}

async function loadUsable(db, recoveryId) {
  const id = typeof recoveryId === "string" ? recoveryId.trim() : "";
  if (!UUID.test(id)) throw invalidId("recoveryId");

  const challenge = await repository.findById(db, id);
  if (!challenge) throw notFound("Unknown recovery challenge");

  assertUsable(challenge);
  return challenge;
}

function view(challenge, application) {
  return {
    status: "AUTHENTICATION_REQUIRED",
    workflowId: application?.workflow_id ?? challenge.workflow_id,
    recoveryId: challenge.recovery_id,
    requiredMethods: challenge.required_methods,
    availableMethods: availableMethods(),
    verifiedMethods: (challenge.required_methods ?? []).filter(
      (factor) => Boolean(challenge[FACTOR_COLUMN[factor]])
    ),
    missingMethods: missingFactors(challenge),
    nextStep: nextStep(challenge),
    expiresAt: challenge.expires_at,
  };
}

/**
 * Step 1: name an application and start proving ownership.
 *
 * Reuses a still-usable challenge for the same application+actor instead of
 * minting a new one, so a page reload cannot reset the attempt budget.
 */
async function start({ workflowId, actor, captchaToken, ip } = {}) {
  if (!config.recovery.enabled) throw unavailable();

  const requested = typeof workflowId === "string" ? workflowId.trim() : "";
  if (!WORKFLOW_ID.test(requested)) throw invalidId("workflowId");

  const workflowActor = String(actor ?? "BORROWER").toUpperCase();
  if (!RECOVERABLE_ACTORS.includes(workflowActor) || !listActors().includes(workflowActor)) {
    throw forbidden("This actor cannot recover an application from a browser");
  }

  const db = getPool();
  const application = await applicationRepository.findByWorkflowId(db, requested);
  // Unknown and "not permitted" answer identically on purpose.
  if (!application) {
    throw new AppError(404, "WORKFLOW_NOT_FOUND", "No resumable application for this workflow");
  }

  if (application.status !== "IN_PROGRESS") {
    throw conflict("WORKFLOW_NOT_RECOVERABLE", "This application can no longer be resumed");
  }

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await repository.countStartsSince(db, application.id, since);
  if (recent >= config.recovery.maxStartsPerHour) {
    throw tooManyRequests("Too many recovery attempts for this application");
  }

  const contact = await repository.findContact(db, application.id, workflowActor);
  const required = requiredMethodsFor(contact);

  if (required.includes(IDENTITY_FACTOR) && !availableMethods().includes(IDENTITY_FACTOR)) {
    // The one thing this must never do is pretend the check happened.
    throw identityUnavailable();
  }

  if (!hasOwnershipFactor(required)) {
    // CAPTCHA alone proves you are a human, not that this application is yours.
    throw conflict(
      "RECOVERY_NOT_AVAILABLE",
      "No ownership check is available for this application"
    );
  }

  const captchaRequired = required.includes(CAPTCHA_FACTOR);
  if (captchaRequired) {
    await captcha.verify({ token: captchaToken, remoteIp: ip, required: true });
  }

  let challenge = await repository.findPending(db, application.id, workflowActor);

  if (challenge) {
    if (captchaRequired && !challenge.captcha_verified_at) {
      await repository.markCaptchaVerified(db, challenge.recovery_id);
      challenge = await repository.findById(db, challenge.recovery_id);
    }
  } else {
    challenge = await repository.create(db, {
      recoveryId: crypto.randomUUID(),
      applicationId: application.id,
      workflowId: application.workflow_id,
      workflowActor,
      requiredMethods: required,
      maxAttempts: config.recovery.maxAttempts,
      expiresAt: expiryDate(config.recovery.challengeTtlMinutes),
    });
    if (captchaRequired) {
      await repository.markCaptchaVerified(db, challenge.recovery_id);
      challenge = await repository.findById(db, challenge.recovery_id);
    }
  }

  return view(challenge, application);
}

/**
 * Step 2: send a code to the number already on file.
 *
 * The number is never returned: the response says "sent", nothing more.
 */
async function requestOtp({ recoveryId } = {}) {
  if (!config.recovery.enabled) throw unavailable();

  const db = getPool();
  const challenge = await loadUsable(db, recoveryId);

  if (!(challenge.required_methods ?? []).includes(OTP_FACTOR)) {
    throw conflict("RECOVERY_METHOD_NOT_REQUIRED", "This recovery does not use a mobile code");
  }

  if (challenge.otp_last_sent_at) {
    const elapsedMs = Date.now() - new Date(challenge.otp_last_sent_at).getTime();
    if (elapsedMs < config.recovery.otpResendSeconds * 1000) {
      throw tooManyRequests("A code was sent very recently; wait before requesting another");
    }
  }

  if (challenge.otp_sends >= config.recovery.maxOtpSends) {
    throw new AppError(
      429,
      "RECOVERY_ATTEMPTS_EXCEEDED",
      "The maximum number of codes has already been sent for this recovery"
    );
  }

  const contact = await repository.findContact(
    db,
    challenge.application_id,
    challenge.workflow_actor
  );
  if (!contact?.mobile_number) {
    throw conflict(
      "RECOVERY_CONTACT_UNAVAILABLE",
      "There is no verified mobile number on file for this application"
    );
  }

  // Reserve the send first: if the cap is already reached this returns null and
  // no code is generated at all.
  const send = await repository.registerOtpSend(
    db,
    challenge.recovery_id,
    config.recovery.maxOtpSends
  );
  if (!send) {
    throw new AppError(
      429,
      "RECOVERY_ATTEMPTS_EXCEEDED",
      "The maximum number of codes has already been sent for this recovery"
    );
  }

  const challengeId = crypto.randomUUID();
  const code = authService.generateCode();
  const expiresAt = expiryDate(config.session.challengeTtlMinutes);

  await authRepository.createChallenge(db, {
    challengeId,
    recoveryId: challenge.recovery_id,
    purpose: "RECOVERY",
    method: OTP_FACTOR,
    // The subject is the number the code went to; only its digest is kept.
    subjectHash: sha256(`recovery-subject:${contact.mobile_number}`),
    codeHash: authService.digestCode(challengeId, code),
    maxAttempts: config.recovery.maxAttempts,
    expiresAt,
  });

  const result = {
    recoveryId: challenge.recovery_id,
    method: OTP_FACTOR,
    sentTo: "the mobile number on file",
    expiresAt,
    resendAfterSeconds: config.recovery.otpResendSeconds,
    sendsRemaining: config.recovery.maxOtpSends - send.otp_sends,
    delivery: "GATEWAY",
  };

  if (config.auth.devMode) {
    // Development only; `AUTH_DEV_MODE` is refused in production. The code is
    // returned so a script or a browser tester can use it — never logged, since
    // logs outlive the request and are shipped elsewhere.
    return { ...result, delivery: "RESPONSE", code };
  }

  if (config.recovery.smsProvider === "dev") {
    // No gateway is wired up; the send is recorded but nothing leaves the
    // process. Returning the code here would be a backdoor, so it is dropped
    // and the operator is told delivery did not happen.
    return { ...result, delivery: "LOG" };
  }

  // No gateway implementation exists; never imply a message was sent.
  throw new AppError(
    503,
    "RECOVERY_DELIVERY_UNAVAILABLE",
    "No SMS provider is configured on this server"
  );
}

/** Step 3: check the code, and record that this factor is satisfied. */
async function verifyOtp({ recoveryId, code } = {}) {
  if (!config.recovery.enabled) throw unavailable();

  const db = getPool();
  const challenge = await loadUsable(db, recoveryId);
  const submitted = requireString(code, "code", { max: 10 });

  // A second verify after a success is a replay, whether or not the underlying
  // code row has been swept up yet.
  if (challenge.otp_verified_at) {
    throw conflict("RECOVERY_CODE_USED", "This code has already been used");
  }

  const open = await authRepository.findOpenByRecovery(db, challenge.recovery_id);
  if (!open) {
    throw conflict("OTP_NOT_REQUESTED", "Request a code before verifying one");
  }
  if (new Date(open.expires_at).getTime() <= Date.now()) {
    throw conflict("OTP_EXPIRED", "This code has expired; request a new one");
  }
  if (open.attempts >= open.max_attempts) {
    throw new AppError(
      429,
      "RECOVERY_ATTEMPTS_EXCEEDED",
      "This code has used all of its attempts; request a new one later"
    );
  }

  const submittedHash = authService.digestCode(open.challenge_id, submitted);
  if (!authService.safeEqualHex(submittedHash, open.code_hash)) {
    await authRepository.registerFailedAttempt(db, open.challenge_id);
    const counters = await repository.registerFailedAttempt(
      db,
      challenge.recovery_id,
      config.recovery.lockoutMinutes
    );

    const remaining = Math.max((counters?.max_attempts ?? 0) - (counters?.attempts ?? 0), 0);
    if (remaining === 0) {
      throw new AppError(
        429,
        "RECOVERY_ATTEMPTS_EXCEEDED",
        "Too many incorrect codes; this recovery is locked for a while"
      );
    }
    throw new AppError(
      401,
      "RECOVERY_CODE_INCORRECT",
      `Incorrect code, ${remaining} attempt${remaining === 1 ? "" : "s"} left`
    );
  }

  // Single use: the conditional consume is what makes a replay fail.
  const consumed = await authRepository.consumeChallenge(db, open.challenge_id);
  if (!consumed) {
    throw conflict("RECOVERY_CODE_USED", "This code has already been used");
  }

  await repository.markOtpVerified(db, challenge.recovery_id);
  const refreshed = await repository.findById(db, challenge.recovery_id);

  return {
    status: missingFactors(refreshed).length === 0 ? "OK" : "AUTHENTICATION_REQUIRED",
    recoveryId: refreshed.recovery_id,
    verifiedMethods: (refreshed.required_methods ?? []).filter(
      (factor) => Boolean(refreshed[FACTOR_COLUMN[factor]])
    ),
    missingMethods: missingFactors(refreshed),
    nextStep: nextStep(refreshed),
  };
}

/**
 * Step 4: mint the session.
 *
 * Everything is re-checked here — the request cannot skip a factor by calling
 * this endpoint directly, and two concurrent calls cannot both win.
 */
async function complete({ recoveryId } = {}) {
  if (!config.recovery.enabled) throw unavailable();

  const id = typeof recoveryId === "string" ? recoveryId.trim() : "";
  if (!UUID.test(id)) throw invalidId("recoveryId");

  const { application, session } = await withTransaction(async (db) => {
    const challenge = await repository.lockById(db, id);
    if (!challenge) throw notFound("Unknown recovery challenge");

    assertUsable(challenge);

    const missing = missingFactors(challenge);
    if (missing.length > 0) {
      throw new AppError(
        409,
        "RECOVERY_REQUIRED",
        `This recovery still needs: ${missing.join(", ")}`
      );
    }

    const target = await applicationRepository.findById(db, challenge.application_id);
    if (!target) {
      throw new AppError(404, "WORKFLOW_NOT_FOUND", "No resumable application for this workflow");
    }
    if (target.status !== "IN_PROGRESS") {
      throw conflict("WORKFLOW_NOT_RECOVERABLE", "This application can no longer be resumed");
    }
    if (target.workflow_id !== challenge.workflow_id) {
      throw conflict("WORKFLOW_MISMATCH", "This recovery belongs to another workflow");
    }

    // The actor comes from the challenge (fixed at start), never from this
    // request, and the normal session policy still applies.
    const issued = await sessionService.issue(db, {
      applicationId: target.id,
      actor: challenge.workflow_actor,
      application: target,
    });

    const consumed = await repository.consume(db, challenge.recovery_id, issued.sessionId);
    if (!consumed) {
      throw conflict("RECOVERY_ALREADY_COMPLETED", "This recovery was already completed");
    }

    return { application: target, session: issued };
  });

  // The engine, not the client, decides where the applicant actually is.
  const fresh = await sessionService.resolveToken(getPool(), session.sessionId);
  const state = await workflowService.getState(application.id, fresh);

  return { application, session: fresh, state };
}

module.exports = {
  availableMethods,
  requiredMethodsFor,
  start,
  requestOtp,
  verifyOtp,
  complete,
  nextStep,
  missingFactors,
};
