/**
 * captchaService.js
 *
 * CAPTCHA is SEPARATE from authentication:
 *   "Request passed bot/abuse verification."
 *   It does NOT mean "User is authenticated."
 *
 * The backend always verifies the CAPTCHA token with the CAPTCHA provider —
 * the frontend's own CAPTCHA result is never trusted.
 *
 * Providers (CAPTCHA_PROVIDER env, or auto-detected):
 *   - "recaptcha" — Google reCAPTCHA via CAPTCHA_SECRET (server-side call;
 *                   the secret never leaves the backend).
 *   - "stub"      — development fallback: token must equal CAPTCHA_DEV_TOKEN
 *                   (shared secret, compared in constant time). Used when no
 *                   provider is configured.
 *
 * When nothing is configured verification FAILS (safe default: the captcha
 * gate stays closed).
 */

const crypto = require("crypto");

class CaptchaService {
  /**
   * @returns {string} active provider name (safe to expose to the frontend)
   */
  getProviderName() {
    if (process.env.CAPTCHA_PROVIDER) {
      return String(process.env.CAPTCHA_PROVIDER).toLowerCase();
    }
    return process.env.CAPTCHA_SECRET ? "recaptcha" : "stub";
  }

  /**
   * CAPTCHA requirement descriptor returned in CAPTCHA_REQUIRED responses.
   */
  describe() {
    return { required: true, provider: this.getProviderName() };
  }

  /**
   * Verifies a CAPTCHA token server-side.
   *
   * @param   {string} token    — token supplied by the frontend
   * @param   {string} [remoteIp]
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async verify(token, remoteIp = null) {
    if (!token || typeof token !== "string" || !token.trim()) {
      return { ok: false, reason: "MISSING_TOKEN" };
    }

    const provider = this.getProviderName();

    try {
      if (provider === "recaptcha") {
        return await this.verifyRecaptcha(token, remoteIp);
      }
      if (provider === "stub") {
        return this.verifyStub(token);
      }
      console.warn(`[captchaService] Unknown provider '${provider}'`);
      return { ok: false, reason: "UNKNOWN_CAPTCHA_PROVIDER" };
    } catch (err) {
      // Provider errors must fail closed — never grant access on error.
      console.error(`[captchaService] Verification error: ${err.message}`);
      return { ok: false, reason: "PROVIDER_ERROR" };
    }
  }

  async verifyRecaptcha(token, remoteIp) {
    const secret = process.env.CAPTCHA_SECRET;
    if (!secret) return { ok: false, reason: "CAPTCHA_NOT_CONFIGURED" };

    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.append("remoteip", remoteIp);

    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      body: params,
    });
    const data = await resp.json();

    return data.success === true
      ? { ok: true }
      : { ok: false, reason: "PROVIDER_REJECTED" };
  }

  verifyStub(token) {
    const expected = process.env.CAPTCHA_DEV_TOKEN;
    if (!expected) return { ok: false, reason: "CAPTCHA_NOT_CONFIGURED" };

    const a = Buffer.from(String(token));
    const b = Buffer.from(String(expected));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

    return ok ? { ok: true } : { ok: false, reason: "INVALID_TOKEN" };
  }
}

module.exports = new CaptchaService();
