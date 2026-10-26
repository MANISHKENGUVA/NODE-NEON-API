/**
 * authenticationProvider.js
 *
 * AuthenticationProvider abstraction + registry.
 *
 * The workflow engine only knows an authentication METHOD (e.g. "AADHAAR",
 * "MOBILE_OTP"). The provider performs the real, server-side verification —
 * the backend never trusts a frontend "authenticated": true claim.
 *
 * Contract:
 *   verify(credential, context) → { verified, subjectHash?, reason? }
 *   [optional] createChallenge(input, context) → { ok, challengeId, code, expiresAt }
 *
 * Register new providers here; the workflow engine is never modified when
 * a new method is added.
 */

const crypto = require("crypto");
const challengeStore = require("./challengeStore");
const sessionManager = require("../session/sessionManager");

class AuthenticationProvider {
  constructor(method) {
    this.method = method;
  }

  supportsChallenges() {
    return false;
  }

  async createChallenge() {
    throw new Error(`Provider '${this.method}' does not support challenges`);
  }

  async verify(/* credential, context */) {
    throw new Error(`Provider '${this.method}' must implement verify()`);
  }
}

/**
 * Base class for OTP-challenge based providers (Mobile OTP, Aadhaar OTP…).
 * Subclasses supply destination normalization + subject derivation.
 */
class ChallengeBasedProvider extends AuthenticationProvider {
  supportsChallenges() {
    return true;
  }

  /** Must return the normalized destination or null when invalid. */
  normalizeDestination(/* destination */) {
    throw new Error("normalizeDestination() not implemented");
  }

  /** Must return a non-reversible subject hash for the destination. */
  buildSubjectHash(/* destination */) {
    throw new Error("buildSubjectHash() not implemented");
  }

  async createChallenge({ destination } = {}) {
    const normalized = this.normalizeDestination(destination);
    if (!normalized) return { ok: false, reason: "INVALID_DESTINATION" };

    const result = await challengeStore.createChallenge({
      method: this.method,
      subjectHash: this.buildSubjectHash(normalized),
      ttlSeconds: sessionManager.challengeTtlSeconds(),
    });

    return { ok: true, ...result };
  }

  async verify(credential = {}) {
    const challengeId = credential.challengeId;
    const code = credential.code ?? credential.otp;

    if (!challengeId || !code) {
      return { verified: false, reason: "CHALLENGE_AND_CODE_REQUIRED" };
    }

    const result = await challengeStore.verifyChallenge({
      challengeId,
      code: String(code),
      method: this.method,
    });

    if (!result.ok) return { verified: false, reason: result.reason };
    return { verified: true, subjectHash: result.subjectHash };
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
const providers = new Map();

function registerProvider(provider) {
  providers.set(provider.method, provider);
}

function getProvider(method) {
  if (typeof method !== "string") return null;
  return providers.get(method.toUpperCase()) ?? null;
}

function listRegisteredMethods() {
  return [...providers.keys()];
}

function subjectHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = {
  AuthenticationProvider,
  ChallengeBasedProvider,
  registerProvider,
  getProvider,
  listRegisteredMethods,
  subjectHash,
};
