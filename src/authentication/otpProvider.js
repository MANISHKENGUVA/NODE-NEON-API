/**
 * otpProvider.js
 *
 * MobileOtpProvider — authentication method "MOBILE_OTP".
 *
 * Verification model (server-side only):
 *   1. POST /api/auth/challenge { method: "MOBILE_OTP", destination: "9876543210" }
 *      → backend generates a 6-digit code, stores only its hash, and hands the
 *        code to the SMS gateway (dev echo requires AUTH_DEV_MODE=true).
 *   2. POST /api/auth/verify { method: "MOBILE_OTP",
 *                              credential: { challengeId, code } }
 *      → backend compares against the stored hash and consumes the challenge.
 *
 * The frontend never gets to assert success — it only relays the code the
 * user received.
 */

const { ChallengeBasedProvider, subjectHash } = require("./authenticationProvider");

class MobileOtpProvider extends ChallengeBasedProvider {
  constructor() {
    super("MOBILE_OTP");
  }

  normalizeDestination(destination) {
    const value = String(destination ?? "").trim();
    return /^[6-9][0-9]{9}$/.test(value) ? value : null;
  }

  buildSubjectHash(destination) {
    return subjectHash(`${this.method}:${destination}`);
  }
}

module.exports = { MobileOtpProvider };
