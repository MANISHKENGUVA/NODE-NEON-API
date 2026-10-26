/**
 * authenticationService.js
 *
 * Generic authentication service.
 *
 *   POST /api/auth/challenge → createChallenge()
 *   POST /api/auth/verify    → verify()
 *
 * Flow on successful verification:
 *   1. Identify the actor (derived server-side from the verified subject)
 *   2. Create the actor authentication session (own expiry)
 *   3. Associate the actor with the workflow session (ANONYMOUS →
 *      ACTOR_AUTHENTICATED)
 *   4. Return success — never the provider's secrets or raw credentials
 *
 * The backend performs the actual verification via the registered
 * AuthenticationProvider. Nothing the frontend sends is trusted as a claim.
 */

const sessionManager = require("../session/sessionManager");
const {
  registerProvider,
  getProvider,
  listRegisteredMethods,
} = require("./authenticationProvider");
const { MobileOtpProvider } = require("./otpProvider");
const { AadhaarProvider } = require("./aadhaarProvider");
const { IdentityProvider } = require("./identityProvider");
const { DocumentVerificationProvider } = require("./documentVerificationProvider");

// Provider registration — add new methods here, never in the workflow engine.
registerProvider(new MobileOtpProvider());
registerProvider(new AadhaarProvider());
registerProvider(new IdentityProvider());
registerProvider(new DocumentVerificationProvider());

function deriveActorId(subjectHashValue) {
  return `ACTOR-${String(subjectHashValue).slice(0, 12).toUpperCase()}`;
}

function isDevMode() {
  return process.env.AUTH_DEV_MODE === "true";
}

/**
 * Creates an authentication challenge for challenge-based methods.
 *
 * @param   {object} input
 * @param   {string} input.sessionId
 * @param   {string} input.method
 * @param   {string} input.destination
 * @returns {Promise<object>} success or error descriptor
 */
async function createChallenge({ sessionId, method, destination }) {
  const loaded = await sessionManager.loadSession(sessionId);
  if (!loaded.ok) return { status: loaded.status, authenticated: false };

  const provider = getProvider(method);
  if (!provider) {
    return {
      httpStatus: 400,
      status: "ERROR",
      authenticated: false,
      reason: "UNSUPPORTED_AUTHENTICATION_METHOD",
      methods: listRegisteredMethods(),
    };
  }

  if (!provider.supportsChallenges()) {
    return {
      httpStatus: 400,
      status: "ERROR",
      authenticated: false,
      reason: "METHOD_DOES_NOT_USE_CHALLENGES",
    };
  }

  const challenge = await provider.createChallenge({ destination });
  if (!challenge.ok) {
    return {
      httpStatus: 400,
      status: "ERROR",
      authenticated: false,
      reason: challenge.reason,
    };
  }

  const response = {
    status: "OK",
    challengeId: challenge.challengeId,
    method: provider.method,
    expiresAt: challenge.expiresAt.toISOString(),
  };

  // Development-only echo so testers can read the code without an SMS gateway.
  // Must stay disabled in production.
  if (isDevMode()) response.devCode = challenge.code;

  return response;
}

/**
 * Verifies a credential with the method's provider and, on success, creates
 * the actor authentication session and associates it with the workflow
 * session.
 *
 * @param   {object} input
 * @param   {string} input.sessionId
 * @param   {string} input.method
 * @param   {object|string} input.credential
 * @param   {string} [input.remoteIp]
 * @returns {Promise<object>}
 */
async function verify({ sessionId, method, credential, remoteIp }) {
  const loaded = await sessionManager.loadSession(sessionId);
  if (!loaded.ok) {
    return {
      httpStatus: 401,
      status: loaded.status,
      authenticated: false,
      sessionId,
    };
  }
  const session = loaded.session;

  const provider = getProvider(method);
  if (!provider) {
    return {
      httpStatus: 400,
      status: "ERROR",
      authenticated: false,
      reason: "UNSUPPORTED_AUTHENTICATION_METHOD",
      methods: listRegisteredMethods(),
    };
  }

  // Provider performs the real server-side verification.
  const result = await provider.verify(credential ?? {}, {
    sessionId,
    workflowId: session.workflow_id,
    remoteIp,
  });

  if (!result.verified) {
    return {
      httpStatus: 401,
      status: "ERROR",
      authenticated: false,
      reason: result.reason || "VERIFICATION_FAILED",
      sessionId,
    };
  }

  // 1. Identify actor (server-derived)  2. actor session  3. association.
  const actorId = deriveActorId(result.subjectHash);
  const auth = await sessionManager.attachActorAuthentication({
    sessionId,
    actorId,
    method: provider.method,
    subjectHash: result.subjectHash,
  });

  return {
    authenticated: true,
    actorId,
    sessionId,
    workflowId: session.workflow_id,
    status: "ACTOR_AUTHENTICATED",
    authentication: {
      method: provider.method,
      verifiedAt: auth.row.verified_at.toISOString(),
      expiresAt: auth.row.expires_at.toISOString(),
    },
  };
}

module.exports = {
  createChallenge,
  verify,
  deriveActorId,
  listRegisteredMethods,
};
