/**
 * Resuming an existing application after the browser lost its session.
 *
 * Two separate identities, deliberately:
 *
 *   workflowId  — an identifier from the URL. Never proof of anything.
 *   wf_recover  — an unguessable, HttpOnly, revocable cookie. The credential.
 *
 * `recover` never creates an application. It can only hand out a new session
 * for an application that already exists, and only if the credential names it.
 * That is what makes "duplicate application on reload" impossible rather than
 * merely unlikely.
 */
const crypto = require("crypto");
const { withTransaction, getPool } = require("../../db/pool");
const { config } = require("../../config/env");
const { sha256 } = require("../../core/hash");
const { AppError } = require("../../core/errors");
const applicationRepository = require("../application/applicationRepository");
const sessionService = require("./sessionService");
const repository = require("./recoveryRepository");

const TOKEN_BYTES = 32;

const digest = (rawToken) => sha256(`recovery:${rawToken}`);

function expiryDate(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function unavailable(message = "This application can no longer be resumed") {
  return new AppError(401, "RECOVERY_UNAVAILABLE", message);
}

/**
 * Issues a credential for an application and returns the raw token once.
 * The caller puts it in the cookie and stores it nowhere else.
 */
async function issue({ applicationId, actor, db }) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = expiryDate(config.session.recoveryTtlHours);

  await repository.create(db ?? getPool(), {
    tokenHash: digest(rawToken),
    applicationId,
    workflowActor: actor,
    expiresAt,
  });

  return { token: rawToken, expiresAt };
}

/**
 * Exchanges a recovery credential for a fresh session without naming a
 * workflow id.
 *
 * This is the duplicate-creation guard for `POST /workflow/session {}`: a
 * browser that already holds a live credential is resumed on the SAME
 * application instead of silently opening a second one. An explicit
 * `newApplication: true` bypasses this function.
 *
 * @returns {Promise<{application: object, session: object, actor: string}>}
 */
async function resume({ rawToken }) {
  if (!rawToken) throw unavailable("No recovery credential is present");

  const tokenHash = digest(rawToken);

  return withTransaction(async (db) => {
    const record = await repository.findLive(db, tokenHash);
    if (!record) throw unavailable();

    const application = await applicationRepository.findById(db, record.application_id);
    if (!application) throw unavailable();

    if (application.status !== "IN_PROGRESS") {
      throw unavailable("This application is no longer in progress");
    }

    const session = await sessionService.issue(db, {
      applicationId: application.id,
      actor: record.workflow_actor,
      application,
    });

    await repository.touch(db, tokenHash);
    return { application, session, actor: record.workflow_actor };
  });
}

/**
 * Exchanges a recovery credential for a fresh session on the same application.
 *
 * @returns {Promise<{application: object, session: object, actor: string}>}
 */
async function recover({ workflowId, rawToken }) {
  if (!rawToken) throw unavailable("No recovery credential is present");

  const tokenHash = digest(rawToken);

  try {
    return await withTransaction(async (db) => {
      const record = await repository.findLive(db, tokenHash);
      if (!record) throw unavailable();

      const application = await applicationRepository.findById(db, record.application_id);
      if (!application) throw unavailable();

      if (application.workflow_id !== workflowId) {
        // The credential belongs to a different application. Casting it out has
        // to happen AFTER the rollback, otherwise it is undone — see the catch.
        throw new AppError(
          409,
          "WORKFLOW_MISMATCH",
          "The recovery credential does not match this workflow"
        );
      }

      if (application.status !== "IN_PROGRESS") {
        throw unavailable("This application is no longer in progress");
      }

      // Reuse the existing session policy: the actor comes from the credential,
      // never from WORKFLOW_ACTOR in the URL, and coborrower/staff rules still
      // apply. The new session is ANONYMOUS — recovery proves continuity, not
      // identity, so no gate is bypassed.
      const session = await sessionService.issue(db, {
        applicationId: application.id,
        actor: record.workflow_actor,
        application,
      });

      await repository.touch(db, tokenHash);

      return { application, session, actor: record.workflow_actor };
    });
  } catch (error) {
    if (error?.code === "WORKFLOW_MISMATCH") {
      // A credential that names the wrong workflow is worthless and dangerous:
      // burn it on its own connection, outside the transaction that just rolled
      // back, so a browser holding two workflows cannot cross them later.
      await repository.revoke(getPool(), tokenHash);
    }
    throw error;
  }
}

module.exports = { issue, resume, recover, unavailable };
