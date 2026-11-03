/**
 * reCAPTCHA v2 verification (server side).
 *
 * The secret key never leaves the server. A token is verified against Google
 * before the protected action runs, and any doubt — missing token, network
 * failure, hostname mismatch — fails the request instead of letting it pass.
 *
 * Tokens are single use: Google answers `timeout-or-duplicate` when one is
 * replayed, so replay protection comes from the verifier itself.
 */
const { config } = require("../../config/env");
const { captchaRequired, captchaInvalid, serviceUnavailable } = require("../../core/errors");

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const TIMEOUT_MS = 5000;

function isConfigured() {
  return Boolean(config.recaptcha.secretKey);
}

function isBypassed() {
  return config.recaptcha.devBypass && !config.isProduction;
}

/**
 * Verifies a token for a protected action.
 *
 * @param {object} input
 * @param {string} [input.token]  value of `g-recaptcha-response`
 * @param {string} [input.remoteIp] caller IP, used by Google as a hint
 * @param {boolean} input.required  whether the node/route demands a captcha
 */
async function verify({ token, remoteIp, required }) {
  if (!required) return;
  if (isBypassed()) return;

  if (!isConfigured()) {
    throw serviceUnavailable("CAPTCHA is not configured on this server");
  }
  if (!token) {
    throw captchaRequired("A reCAPTCHA token is required");
  }

  let payload;
  try {
    const body = new URLSearchParams({ secret: config.recaptcha.secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    payload = await response.json();
  } catch {
    // Never log the token or the secret.
    throw serviceUnavailable("CAPTCHA verification is temporarily unavailable");
  }

  if (payload?.success !== true) {
    const codes = Array.isArray(payload?.["error-codes"]) ? payload["error-codes"] : [];
    const reason = codes.includes("timeout-or-duplicate")
      ? "CAPTCHA token has expired or was already used"
      : "CAPTCHA verification failed";
    throw captchaInvalid(reason);
  }

  const allowed = config.recaptcha.allowedHostnames;
  if (allowed.length > 0 && !allowed.includes(payload.hostname)) {
    throw captchaInvalid("CAPTCHA was solved on an untrusted host");
  }
}

module.exports = { verify, isConfigured, isBypassed };
