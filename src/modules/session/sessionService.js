/**
 * Session policy for the workflow API.
 *
 * The actor is decided by the server, never by the request body:
 *
 *   - the creator of an application gets a BORROWER session,
 *   - a COBORROWER session is only issued once the workflow has actually
 *     reached the coborrower stage,
 *   - LENDER and MANAGER sessions require the admin API key.
 *
 * Without those rules a client could simply claim to be the lender and walk
 * the application to "disbursed".
 */
const { config } = require("../../config/env");
const { run } = require("../../db/pool");
const { listActors, getActorForNode } = require("../../workflow/definition");
const {
  sessionInvalid,
  sessionExpired,
  sessionRevoked,
  forbidden,
  conflict,
  notFound,
} = require("../../core/errors");
const { newSessionId } = require("../../core/ids");
const repository = require("./sessionRepository");

const SESSION_HEADER = "x-workflow-session";
const STAFF_ACTORS = Object.freeze(["LENDER", "MANAGER"]);

function expiryDate(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/** Throws unless `actor` may open a session on this application. */
function assertCanIssue({ actor, application, isAdmin }) {
  if (!listActors().includes(actor)) {
    throw conflict("UNKNOWN_ACTOR", `'${actor}' is not an actor in this workflow`);
  }

  if (STAFF_ACTORS.includes(actor) && !isAdmin) {
    throw forbidden(`${actor} sessions require the admin API key`);
  }

  if (actor === "COBORROWER" && !isAdmin) {
    const reachedCoborrower = getActorForNode(application.current_node) === "COBORROWER";
    if (!reachedCoborrower) {
      throw conflict(
        "COBORROWER_STAGE_NOT_REACHED",
        "This application has not reached the coborrower stage yet"
      );
    }
  }
}

async function issue(db, { applicationId, actor, isAdmin = false, application }) {
  const target = application ?? (await loadApplication(db, applicationId));
  assertCanIssue({ actor, application: target, isAdmin });

  const sessionId = newSessionId();
  const row = await repository.create(db, {
    sessionId,
    applicationId: target.id,
    workflowActor: actor,
    expiresAt: expiryDate(config.session.workflowTtlMinutes),
  });

  return { sessionId: row.session_id, actor: row.workflow_actor, expiresAt: row.expires_at };
}

function loadApplication(db, applicationId) {
  return run(db, "SELECT * FROM loan_applications WHERE id = $1", [applicationId]).then(
    (result) => result.rows[0] ?? null
  );
}

/**
 * Validates a raw session id and returns the session facts.
 *
 * The id is opaque and server-issued; the actor always comes from the stored
 * row, never from the caller.
 */
async function resolveToken(db, sessionId) {
  if (!sessionId) return null;

  const session = await repository.findById(db, sessionId);
  if (!session) throw sessionInvalid("Unknown workflow session");
  if (session.revoked_at) throw sessionRevoked("Workflow session has been revoked");

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw sessionExpired("Workflow session has expired");
  }

  // The stored status is a historical fact ("this session once authenticated").
  // The effective status has to account for the actor proof's own expiry, which
  // is shorter than the workflow session.
  const activeAuthentication =
    session.status === "ACTOR_AUTHENTICATED"
      ? await repository.findActiveAuthentication(db, session.session_id)
      : null;
  const authenticationExpired =
    session.status === "ACTOR_AUTHENTICATED" && !activeAuthentication;

  return {
    sessionId: session.session_id,
    applicationId: session.application_id,
    actor: session.workflow_actor,
    // `status` is the effective status the resolver and gates branch on.
    // `storedStatus` keeps the database value available for audit/debugging.
    status: authenticationExpired ? "ACTOR_SESSION_EXPIRED" : session.status,
    storedStatus: session.status,
    actorId: session.actor_id,
    expiresAt: session.expires_at,
    captchaVerifiedAt: session.captcha_verified_at ?? null,
    authenticationExpired,
    authenticationExpiresAt: activeAuthentication?.expires_at ?? null,
  };
}

/** Revokes a workflow session. Safe to call twice; never reveals a raw token. */
async function revoke(db, sessionId) {
  if (!sessionId) throw sessionInvalid("Unknown workflow session");

  const revoked = await repository.revoke(db, sessionId);
  if (revoked) {
    return { sessionId, revoked: true, alreadyRevoked: false, revokedAt: revoked.revoked_at };
  }

  // Either the id never existed or it was already revoked. Distinguish those
  // so an operator can tell a replay from a typo, without leaking anything.
  const existing = await repository.findById(db, sessionId);
  if (!existing) throw sessionInvalid("Unknown workflow session");
  return {
    sessionId,
    revoked: true,
    alreadyRevoked: true,
    revokedAt: existing.revoked_at,
  };
}

/** Reads and validates the session header. Returns `null` when absent. */
function resolve(db, req) {
  return resolveToken(db, req.get(SESSION_HEADER));
}

/** Same as `resolve` but the header is mandatory. */
async function requireSession(db, req) {
  const session = await resolve(db, req);
  if (!session) throw sessionInvalid(`Missing ${SESSION_HEADER} header`);
  return session;
}

/** Guards against using a session on somebody else's application. */
function assertApplication(session, applicationId) {
  if (session.applicationId !== applicationId) {
    throw notFound("Application not found");
  }
}

/** The session actor must own the node being completed. */
function assertActor(session, actor) {
  if (session.actor !== actor) {
    throw forbidden(`This step belongs to the ${actor} actor`);
  }
}

/** True when the session holds an unexpired authentication for `method`. */
async function hasAuthentication(db, session, method) {
  const result = await run(
    db,
    `SELECT 1
       FROM actor_authentications
      WHERE session_id = $1
        AND method = $2
        AND status = 'ACTIVE'
        AND expires_at > now()
      LIMIT 1`,
    [session.sessionId, method]
  );
  return result.rowCount > 0;
}

/** True when the session holds an unexpired authentication for any method. */
async function hasAnyAuthentication(db, session, methods) {
  for (const method of methods) {
    if (await hasAuthentication(db, session, method)) return true;
  }
  return false;
}

/** Throws unless the session holds one of the accepted authentications. */
async function assertAuthentication(db, session, methods) {
  if (await hasAnyAuthentication(db, session, methods)) return;
  throw forbidden(`This step requires ${methods.join(" or ")} authentication`);
}

module.exports = {
  SESSION_HEADER,
  STAFF_ACTORS,
  assertCanIssue,
  issue,
  resolve,
  resolveToken,
  requireSession,
  assertApplication,
  assertActor,
  revoke,
  hasAuthentication,
  hasAnyAuthentication,
  assertAuthentication,
};
