/**
 * accessResolver.js
 *
 * Answers: "Can the current session/actor access this node?"
 *
 * It runs AFTER transition resolution (the Rule Engine only answers
 * "What is the next workflow node?" — authentication decisions never live
 * inside the Rule Engine).
 *
 * Node access types:
 *   PUBLIC   — any valid workflow session (anonymous is fine)
 *   PUBLIC + captcha — same, plus a server-verified CAPTCHA token
 *   ACTOR    — session must carry a valid, non-expired actor authentication
 *              whose method is acceptable for the node
 *   INTERNAL — internal service callers only (INTERNAL_SERVICE_TOKEN)
 */

const crypto = require("crypto");
const captchaService = require("../captcha/captchaService");
const sessionManager = require("../session/sessionManager");
const { getNodeAccess, ACCESS_TYPES } = require("./accessPolicy");

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Evaluates an access configuration against a (validated) workflow session.
 *
 * Pure decision logic aside from the actor-session lookup + captcha check.
 *
 * @param   {object} params
 * @param   {object} params.access          — normalized access (accessPolicy)
 * @param   {object} [params.session]       — workflow_sessions row (validated)
 * @param   {string} [params.captchaToken]
 * @param   {string} [params.internalToken] — X-Internal-Token header value
 * @param   {string} [params.remoteIp]
 * @returns {Promise<object>} decision: { outcome, access, ... }
 *          outcome ∈ OK | CAPTCHA_REQUIRED | AUTHENTICATION_REQUIRED | ACCESS_DENIED
 */
async function evaluateAccess({ access, session, captchaToken, internalToken, remoteIp }) {
  // ── INTERNAL ─────────────────────────────────────────────────────────────
  if (access.type === ACCESS_TYPES.INTERNAL) {
    const expected = process.env.INTERNAL_SERVICE_TOKEN;
    if (expected && internalToken && safeEqual(internalToken, expected)) {
      return { outcome: "OK", access };
    }
    return { outcome: "ACCESS_DENIED", access, reason: "INTERNAL_NODE" };
  }

  // ── ACTOR ────────────────────────────────────────────────────────────────
  if (access.type === ACCESS_TYPES.ACTOR) {
    let actorAuth = { session: null, expired: false };
    if (session) {
      actorAuth = await sessionManager.getActorAuthentication(session.session_id);
    }

    const actorSession = actorAuth.session;
    const hasActor =
      Boolean(session) &&
      session.status === "ACTOR_AUTHENTICATED" &&
      Boolean(session.actor_id) &&
      Boolean(actorSession) &&
      !actorAuth.expired;

    const methodAcceptable =
      hasActor &&
      (access.authentication.methods === null ||
        access.authentication.methods.includes(actorSession.method));

    if (!hasActor || !methodAcceptable) {
      let reason = "NOT_AUTHENTICATED";
      if (session && (session.actor_id || actorSession)) {
        reason = !hasActor ? "AUTHENTICATION_EXPIRED" : "METHOD_NOT_ACCEPTABLE";
      }
      return {
        outcome: "AUTHENTICATION_REQUIRED",
        access,
        authentication: { methods: access.authentication.methods ?? [] },
        reason,
      };
    }

    // Optional captcha on top of actor authentication.
    if (access.captcha.required) {
      const captcha = await captchaService.verify(captchaToken, remoteIp);
      if (!captcha.ok) {
        return { outcome: "CAPTCHA_REQUIRED", access, reason: captcha.reason };
      }
    }

    return {
      outcome: "OK",
      access,
      authentication: {
        method: actorSession.method,
        verifiedAt: actorSession.verified_at,
        expiresAt: actorSession.expires_at,
        actorId: session.actor_id,
      },
    };
  }

  // ── PUBLIC (default) ─────────────────────────────────────────────────────
  if (access.captcha.required) {
    const captcha = await captchaService.verify(captchaToken, remoteIp);
    if (!captcha.ok) {
      return { outcome: "CAPTCHA_REQUIRED", access, reason: captcha.reason };
    }
    return {
      outcome: "OK",
      access: { ...access, captcha: { ...access.captcha, verified: true } },
    };
  }

  return { outcome: "OK", access };
}

/**
 * Loads the node's access configuration and evaluates it.
 *
 * @param   {object} params — same as evaluateAccess plus `nodeKey`
 * @returns {Promise<object>}
 */
async function resolveNodeAccess({ nodeKey, session, captchaToken, internalToken, remoteIp }) {
  const access = getNodeAccess(nodeKey);
  return evaluateAccess({ access, session, captchaToken, internalToken, remoteIp });
}

module.exports = {
  evaluateAccess,
  resolveNodeAccess,
};
