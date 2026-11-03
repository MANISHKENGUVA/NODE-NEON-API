/**
 * Cookie helpers for the recovery credential.
 *
 * Express can set cookies without any dependency; reading the header is a small
 * parse. Only the long-lived recovery token uses a cookie — the session itself
 * stays in the body/header, so the ordinary API needs no CSRF token and this
 * cookie is scoped to `/workflow` only.
 */
const { config } = require("../config/env");

const RECOVERY_COOKIE = "wf_recover";

function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;

  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** HttpOnly, SameSite=Lax, `Secure` in production, scoped to the workflow. */
function recoveryCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    path: "/workflow",
    ...(expiresAt ? { expires: new Date(expiresAt) } : {}),
  };
}

const readRecoveryCookie = (req) => readCookie(req, RECOVERY_COOKIE);

function setRecoveryCookie(res, token, expiresAt) {
  res.cookie(RECOVERY_COOKIE, token, recoveryCookieOptions(expiresAt));
}

function clearRecoveryCookie(res) {
  res.clearCookie(RECOVERY_COOKIE, recoveryCookieOptions());
}

module.exports = {
  RECOVERY_COOKIE,
  readCookie,
  readRecoveryCookie,
  setRecoveryCookie,
  clearRecoveryCookie,
};
