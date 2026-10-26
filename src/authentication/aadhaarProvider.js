/**
 * aadhaarProvider.js
 *
 * AadhaarProvider — authentication method "AADHAAR".
 *
 * Verification model (server-side only, same challenge pattern as OTP):
 *   1. POST /api/auth/challenge { method: "AADHAAR", destination: "<12 digits>" }
 *   2. POST /api/auth/verify { method: "AADHAAR",
 *                              credential: { challengeId, code } }
 *
 * Swap this provider for a real UIDAI/KYC gateway integration by keeping the
 * AuthenticationProvider interface: the workflow engine only ever sees
 * method = "AADHAAR" and never a provider-specific detail.
 *
 * Only a salted hash of the Aadhaar number is retained for actor identity —
 * the raw number is not persisted in the session/authentication tables.
 */

const { ChallengeBasedProvider, subjectHash } = require("./authenticationProvider");

class AadhaarProvider extends ChallengeBasedProvider {
  constructor() {
    super("AADHAAR");
  }

  normalizeDestination(destination) {
    const value = String(destination ?? "").trim();
    return /^\d{12}$/.test(value) ? value : null;
  }

  buildSubjectHash(destination) {
    return subjectHash(`${this.method}:${destination}`);
  }
}

module.exports = { AadhaarProvider };
