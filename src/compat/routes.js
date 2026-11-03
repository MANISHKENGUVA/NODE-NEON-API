/**
 * Compatibility layer for the browser frontend.
 *
 * The canonical API lives under `/api` and speaks this backend's own words.
 * The frontend calls `/workflow/*` with a `sessionId` in the body and branches
 * on `status`. Rather than fork the engine, these routes translate the dialect:
 * same services, same transactions, same rules.
 *
 * Nothing here decides business logic — every call delegates to the module that
 * already owns the decision. Delete this file and the canonical API still works.
 */
const express = require("express");
const { getPool, run } = require("../db/pool");
const { handler, success } = require("../core/http");
const { requireIdempotencyKey, requireEventId } = require("../core/idempotency");
const { rateLimit } = require("../middleware/security");
const {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} = require("../core/errors");
const { config } = require("../config/env");
const applicationService = require("../modules/application/applicationService");
const applicationRepository = require("../modules/application/applicationRepository");
const sessionService = require("../modules/session/sessionService");
const sessionRepository = require("../modules/session/sessionRepository");
const authService = require("../modules/auth/authService");
const authRepository = require("../modules/auth/authRepository");
const captcha = require("../modules/captcha/captchaService");
const workflowService = require("../workflow/workflowService");
const recoveryService = require("../modules/session/recoveryService");
const recoveryChallenge = require("../modules/recovery/recoveryController");
const {
  readRecoveryCookie,
  setRecoveryCookie,
  clearRecoveryCookie,
} = require("../core/cookies");
const { toResolveView, toLegacyView, toBootstrapView } = require("./view");
const { normalizeStepData } = require("./payload");
const { advanceInternalSteps } = require("./devInternal");

const router = express.Router();

// Recovery challenge flow (`/workflow/recovery/start|otp/request|otp/verify|complete`).
// The router is the canonical one — mounted, not reimplemented.
router.use("/workflow/recovery", recoveryChallenge.router);

/** The frontend names mobile OTP simply "OTP". */
const METHOD_ALIASES = Object.freeze({ OTP: "MOBILE_OTP", SMS: "MOBILE_OTP" });

/**
 * The session named in the body, or in the canonical header if present.
 *
 * The actor is never read from the request — it comes from the stored session,
 * so a body field cannot claim to be the lender.
 */
async function bodySession(req) {
  const sessionId = req.body?.sessionId ?? req.get(sessionService.SESSION_HEADER);
  if (!sessionId) throw unauthorized("sessionId is required");
  return sessionService.resolveToken(getPool(), sessionId);
}

function captchaTokenFrom(req) {
  return req.body?.captchaToken ?? req.get("x-captcha-token") ?? undefined;
}

/** Fresh session facts, so a caller sees its own writes (e.g. captcha flag). */
function reloadSession(session) {
  return sessionService.resolveToken(getPool(), session.sessionId);
}

/** The applicant's own number — the subject an OTP would be delivered to. */
async function mobileNumberFor(db, applicationId, actor) {
  const result = await run(
    db,
    `SELECT a.mobile_number
       FROM loan_applications l
       JOIN applicants a
         ON a.id = CASE
              WHEN $2 = 'COBORROWER' THEN l.coborrower_id
              ELSE l.borrower_id
            END
      WHERE l.id = $1`,
    [applicationId, String(actor ?? "BORROWER").toUpperCase()]
  );
  return result.rows[0]?.mobile_number ?? null;
}

/**
 * Only an approved origin may present the recovery cookie.
 *
 * `SameSite=Lax` already stops the common cross-site POST; this closes the
 * browsers and proxies that disagree about it. Same-origin form posts and curl
 * send no `Origin` at all, so they are unaffected.
 */
function trustedOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return true;
  const allowed = config.corsOrigins;
  return allowed.length === 0 || allowed.includes(origin);
}

/**
 * Server-side recovery. The credential is the HttpOnly cookie; `workflowId` is
 * only compared against it. A workflow id on its own yields nothing.
 */
async function recoverInto(req, res, workflowId, rawToken) {
  try {
    if (!trustedOrigin(req)) {
      throw forbidden("This origin may not resume workflow sessions");
    }
    if (!rawToken) throw recoveryService.unavailable("No recovery credential is present");

    const result = await recoveryService.recover({ workflowId, rawToken });
    const session = await sessionService.resolveToken(getPool(), result.session.sessionId);

    return success(
      res,
      toBootstrapView({ application: workflowService.toSummary(result.application), session })
    );
  } catch (error) {
    // A refused credential is worthless: drop it so the browser stops sending it.
    if (error?.code === "RECOVERY_UNAVAILABLE" || error?.code === "WORKFLOW_MISMATCH") {
      clearRecoveryCookie(res);
    }
    throw error;
  }
}

/**
 * Bootstrap. Four distinct outcomes, never conflated:
 *
 *   { sessionId }              -> reuse that session
 *   { workflowId }             -> resume that application, cookie required
 *   {} with a live cookie      -> resume the SAME application (no duplicate)
 *   { newApplication: true }   -> a genuinely new application
 *
 * The implicit cookie resume is what makes a reload, a second tab, or a retry
 * harmless: the browser already proved continuity, so opening another loan
 * would be a write nobody asked for. An explicit "start a new application"
 * action must send `newApplication: true`. Without a live credential the
 * endpoint refuses with `NEW_APPLICATION_REQUIRED` instead of creating a loan
 * as a side effect of a missing cookie.
 */
router.post(
  "/workflow/session",
  handler(async (req, res) => {
    const db = getPool();
    const body = req.body ?? {};

    if (body.sessionId) {
      const session = await sessionService.resolveToken(db, body.sessionId);
      const application = await applicationRepository.findById(db, session.applicationId);
      if (!application) throw notFound("Application not found");
      return success(
        res,
        toBootstrapView({ application: workflowService.toSummary(application), session })
      );
    }

    if (body.workflowId) {
      return recoverInto(req, res, body.workflowId, readRecoveryCookie(req));
    }

    if (body.newApplication !== true) {
      const rawToken = readRecoveryCookie(req);
      if (rawToken) {
        try {
          const resumed = await recoveryService.resume({ rawToken });
          const session = await sessionService.resolveToken(db, resumed.session.sessionId);
          return success(
            res,
            toBootstrapView({
              application: workflowService.toSummary(resumed.application),
              session,
            })
          );
        } catch (error) {
          // A dead credential must not block a fresh start, but only these
          // refusals are safe to treat as "the cookie is gone". Database and
          // programming errors still surface.
          if (
            error?.code !== "RECOVERY_UNAVAILABLE" &&
            error?.code !== "WORKFLOW_MISMATCH" &&
            error?.code !== "COBORROWER_STAGE_NOT_REACHED"
          ) {
            throw error;
          }
          clearRecoveryCookie(res);
        }
      }

      // No session, no named workflow, no live credential and no explicit
      // creation intent: the browser cannot tell whether an application exists,
      // so the server must not guess by opening a second loan. The caller has
      // to choose between resuming a named application and starting a new one.
      throw conflict(
        "NEW_APPLICATION_REQUIRED",
        "No resumable application was found; send newApplication: true to start a new application"
      );
    }

    const created = await applicationService.create({
      captchaToken: captchaTokenFrom(req),
      ip: req.ip,
      idempotencyKey: requireIdempotencyKey(req),
    });
    const session = await sessionService.resolveToken(db, created.session.sessionId);

    // Hand the browser a credential so a later storage wipe can resume here.
    const recovery = await recoveryService.issue({
      db,
      applicationId: created.application.id,
      actor: session.actor,
    });
    setRecoveryCookie(res, recovery.token, recovery.expiresAt);

    return success(
      res,
      toBootstrapView({ application: workflowService.toSummary(created.application), session }),
      created.created ? 201 : 200
    );
  })
);

/** Explicit resume endpoint, for a frontend that separates the two operations. */
router.post(
  "/workflow/session/recover",
  handler(async (req, res) => {
    const workflowId = req.body?.workflowId;
    if (!workflowId) throw badRequest("MISSING_WORKFLOW_ID", "'workflowId' is required");
    return recoverInto(req, res, workflowId, readRecoveryCookie(req));
  })
);

/**
 * Revokes the session named in the body/header.
 *
 * The raw session id is a bearer credential, so possessing it is sufficient to
 * revoke it. This endpoint is idempotent: revoking an already-revoked session
 * succeeds, which makes a retried "start over" harmless.
 */
router.post(
  "/workflow/session/revoke",
  handler(async (req, res) => {
    const sessionId = req.body?.sessionId ?? req.get(sessionService.SESSION_HEADER);
    if (!sessionId) throw unauthorized("sessionId is required");

    const result = await sessionService.revoke(getPool(), sessionId);
    clearRecoveryCookie(res);
    return success(res, { status: "OK", ...result });
  })
);

/** The authoritative "where is this user now?" call. */
router.post(
  "/workflow/resolve",
  handler(async (req, res) => {
    const session = await bodySession(req);
    // Development only; a no-op unless DEV_SIMULATE_INTERNAL_STEPS is set.
    await advanceInternalSteps(session.applicationId, session);
    const refreshed = await reloadSession(session);
    const state = await workflowService.getState(session.applicationId, refreshed);
    return success(
      res,
      toResolveView({
        application: state.application,
        node: state.node,
        session: refreshed,
        state,
      })
    );
  })
);

/** Submits one step. The backend decides the next node, never the client. */
router.post(
  "/workflow/event",
  handler(async (req, res) => {
    const session = await bodySession(req);
    const body = req.body ?? {};

    const nodeKey =
      body.node ?? body.componentViewRenderState ?? body.workflowMetadata?.componentViewRenderState;
    if (!nodeKey) throw badRequest("MISSING_NODE", "'node' is required");

    const eventId = requireEventId(req, body.eventId ?? body.clientEventId);

    const mutation = await workflowService.submitStep({
      applicationId: session.applicationId,
      nodeKey,
      data: normalizeStepData(nodeKey, body.formData ?? body.data ?? {}),
      session,
      ip: req.ip,
      captchaToken: captchaTokenFrom(req),
      eventId,
    });

    // Development only; a no-op unless DEV_SIMULATE_INTERNAL_STEPS is set.
    await advanceInternalSteps(session.applicationId, session);

    // Re-read: the step may have set a flag on the session, and the simulator
    // may have moved the application past several internal nodes.
    const refreshed = await reloadSession(session);
    const state = await workflowService.getState(session.applicationId, refreshed);
    return success(res, {
      ...toResolveView({
        application: state.application,
        node: state.node,
        session: refreshed,
        state,
      }),
      duplicateEvent: Boolean(mutation.duplicateEvent),
    });
  })
);

/**
 * Verifies an OTP/Aadhaar code.
 *
 * A challenge must exist before a code can be checked; this endpoint verifies
 * the newest open one. With no open challenge it can only issue one in dev mode
 * (where the code is returned instead of being texted) — there is no delivery
 * gateway in this build, so production answers 501 rather than pretending.
 */
router.post(
  "/auth/verify",
  rateLimit({ windowMs: 10 * 60 * 1000, max: 20, name: "compat-auth" }),
  handler(async (req, res) => {
    const db = getPool();
    const session = await bodySession(req);
    const body = req.body ?? {};
    const method = METHOD_ALIASES[String(body.method ?? "").toUpperCase()] ?? body.method ?? "MOBILE_OTP";
    const code = body.otp ?? body.code ?? body.credential;

    const challenge = body.challengeId
      ? await authRepository.findChallenge(db, body.challengeId)
      : await authRepository.findOpenBySession(db, session.sessionId);

    if (!challenge) {
      if (!config.auth.devMode) {
        throw new AppError(
          501,
          "AUTH_GATEWAY_NOT_CONFIGURED",
          "No authentication challenge is open and no delivery gateway is configured"
        );
      }

      const started = await authService.start({
        db,
        session,
        method,
        subject:
          body.subject ??
          body.mobileNumber ??
          body.aadhaarNumber ??
          (method === "MOBILE_OTP"
            ? await mobileNumberFor(db, session.applicationId, session.actor)
            : undefined),
      });
      // The browser gate knows `devCode`; the service calls it `code`.
      return success(
        res,
        { authenticated: false, status: "OK", ...started, devCode: started.code },
        201
      );
    }

    const verified = await authService.verify({
      db,
      session,
      challengeId: challenge.challenge_id,
      code,
    });

    return success(res, {
      authenticated: true,
      actorId: session.actor,
      status: "OK",
      ...verified,
    });
  })
);

/** Records that this session solved a captcha, so state stops asking for one. */
router.post(
  // The frontend contract says `/workflow/captcha/verify`, the older flow
  // designer says `/captcha/verify`. Both are cheap to serve.
  ["/workflow/captcha/verify", "/captcha/verify"],
  handler(async (req, res) => {
    const session = await bodySession(req);

    await captcha.verify({
      token: req.body?.token ?? req.get("x-captcha-token"),
      remoteIp: req.ip,
      required: true,
    });
    await sessionRepository.markCaptchaVerified(getPool(), session.sessionId);

    return success(res, { status: "OK", verified: true });
  })
);

/** Legacy bootstrap path — same answer, wrapped in `componentviewrender`. */
router.post(
  "/api/workflow-navigator",
  handler(async (req, res) => {
    const session = await bodySession(req);
    const state = await workflowService.getState(session.applicationId, session);
    return success(
      res,
      toLegacyView(
        toResolveView({
          application: state.application,
          node: state.node,
          session,
          state,
        })
      )
    );
  })
);

module.exports = router;
