/**
 * Service-to-service credentials.
 *
 * - `requireAdminKey`         protects operator endpoints (API key).
 * - `isTrustedInternalCaller` marks calls allowed to complete SYSTEM flow
 *   nodes and write verification results (shared internal token).
 */
const crypto = require("crypto");
const { config } = require("../config/env");
const { unauthorized, serviceUnavailable } = require("../core/errors");

function safeEqual(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** True when the request carries the configured admin API key. */
function hasAdminKey(req) {
  const expected = config.security.adminApiKey;
  if (!expected) return false;
  const provided = req.get("x-api-key");
  return Boolean(provided) && safeEqual(provided, expected);
}

function requireAdminKey(req, res, next) {
  if (!config.security.adminApiKey) {
    return next(serviceUnavailable("Admin API is not configured on this deployment"));
  }
  if (!hasAdminKey(req)) {
    return next(unauthorized("A valid API key is required"));
  }
  return next();
}

/** True when the request carries the configured internal service token. */
function isTrustedInternalCaller(req) {
  const expected = config.security.internalToken;
  if (!expected) return false;
  const provided = req.get("x-internal-token");
  return Boolean(provided) && safeEqual(provided, expected);
}

/** Guards the endpoints only trusted services may call. */
function requireInternalToken(req, res, next) {
  if (!config.security.internalToken) {
    return next(serviceUnavailable("Internal API is not configured on this deployment"));
  }
  if (!isTrustedInternalCaller(req)) {
    return next(unauthorized("A valid internal service token is required"));
  }
  return next();
}

module.exports = { hasAdminKey, requireAdminKey, isTrustedInternalCaller, requireInternalToken, safeEqual };
