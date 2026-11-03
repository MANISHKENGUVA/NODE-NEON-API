/**
 * Hashing and masking for sensitive identifiers.
 *
 * PAN and Aadhaar numbers are never stored in clear text: we keep a peppered
 * SHA-256 digest plus the last four digits, which is enough to recognise a
 * returning applicant without holding the number itself.
 */
const crypto = require("crypto");
const { config } = require("../config/env");

const DEV_PEPPER = "development-only-pepper-change-me";

function pepper() {
  const configured = config.security.piiPepper;
  if (configured) return configured;
  if (config.isProduction) {
    // validateConfig() refuses to boot without it; this is the last guard.
    throw new Error("PII_HASH_PEPPER is not configured");
  }
  return DEV_PEPPER;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Stable, peppered digest for a national identifier. */
function hashIdentifier(value) {
  return sha256(`${pepper()}:${String(value).trim().toUpperCase()}`);
}

/** Last four characters of an identifier, for display. */
function lastFour(value) {
  return String(value).trim().slice(-4);
}

/** `123456789012` -> `********9012`. Keeps support conversations possible. */
function maskIdentifier(value) {
  const text = String(value).trim();
  if (text.length <= 4) return text;
  return "*".repeat(text.length - 4) + text.slice(-4);
}

module.exports = { sha256, hashIdentifier, lastFour, maskIdentifier };
