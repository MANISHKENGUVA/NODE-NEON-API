/**
 * Lender steps: loan amount, offer acceptance, e-signature, mandate and a
 * failed disbursement retry.
 */
const v = require("../../core/validation");
const { validationFailed, conflict } = require("../../core/errors");
const applicationRepository = require("../application/applicationRepository");
const lendingRepository = require("./lendingRepository");

const MAXIMUM_LOAN_AMOUNT = 100_000_000;
const ESIGN_STATUSES = Object.freeze(["SIGNED", "FAILED"]);
const MANDATE_STATUSES = Object.freeze(["ACTIVE", "FAILED"]);

/** `ED60` needs a positive amount within the product limit. */
async function loanAmount({ db, application, data }) {
  const amount = v.requireNumber(data.amount, "amount", {
    min: 1,
    max: MAXIMUM_LOAN_AMOUNT,
  });

  await applicationRepository.setRequestedAmount(db, application.id, { amount, valid: true });

  return { amount, valid: true };
}

/** `ED62`/`ED63` need the borrower's answer to the offer. */
async function loanOffer({ db, application, data }) {
  const accepted = v.requireBoolean(data.accepted, "accepted");

  const offer = await lendingRepository.upsertOffer(db, application.id, {
    borrowerAccepted: accepted,
    acceptedAt: accepted ? new Date() : null,
  });

  return { accepted: offer.borrower_accepted };
}

/** `ED77`/`ED78` read the e-sign result. */
async function esign({ db, application, data }) {
  const status = v.requireEnum(data.status, "status", ESIGN_STATUSES);

  const offer = await lendingRepository.upsertOffer(db, application.id, { esignStatus: status });

  return { esignStatus: offer.esign_status };
}

/**
 * `ED79` only continues on an active mandate; a failed mandate has no path in
 * this flow version, so it is reported instead of leaving the application in a
 * state nobody can leave.
 */
async function mandate({ db, application, data }) {
  const status = v.requireEnum(data.status, "status", MANDATE_STATUSES);

  if (status === "FAILED") {
    throw validationFailed(
      "A failed mandate has no transition in this flow version; the application needs manual handling"
    );
  }

  const offer = await lendingRepository.upsertOffer(db, application.id, { mandateStatus: status });

  return { mandateStatus: offer.mandate_status };
}

/** `ED86`/`ED87` decide between another attempt and a rejection. */
async function disbursementFailed({ db, application, data }) {
  const retry = v.requireBoolean(data.retry, "retry");

  const disbursement = await lendingRepository.updateLatestDisbursement(db, application.id, {
    retryAllowed: retry,
  });

  if (!disbursement) {
    throw conflict("NO_DISBURSEMENT", "There is no disbursement attempt to retry");
  }

  return { retryAllowed: disbursement.retry_allowed };
}

module.exports = { loanAmount, loanOffer, esign, mandate, disbursementFailed };
