/**
 * Manager review steps.
 *
 * Every review writes an `underwriting_decisions` row; the rule engine reads
 * the latest decision of each type, so a re-submitted review simply supersedes
 * the previous one and the whole history stays auditable.
 */
const v = require("../../core/validation");
const lendingRepository = require("../lending/lendingRepository");

const APPROVE_OR_REJECT = Object.freeze(["APPROVED", "REJECTED"]);
const CLEAR_OR_REJECT = Object.freeze(["CLEAR", "REJECTED"]);
const CLEAR_OR_FLAG = Object.freeze(["CLEAR", "FLAGGED"]);

/** Builds a handler that records one manager decision. */
function decisionHandler(decisionType, allowedDecisions) {
  return async function handler({ db, application, data, session }) {
    const decision = v.requireEnum(data.decision, "decision", allowedDecisions);

    const record = await lendingRepository.insertDecision(db, application.id, {
      decisionType,
      decision,
      remarks: v.optionalString(data.remarks, "remarks", { max: 1000 }),
      decidedByRole: "MANAGER",
      decidedBy: session.actorId,
    });

    return { decisionType, decision, decidedAt: record.decided_at };
  };
}

module.exports = {
  creditException: decisionHandler("CREDIT_EXCEPTION", APPROVE_OR_REJECT),
  fraudReview: decisionHandler("FRAUD_REVIEW", CLEAR_OR_REJECT),
  documentReview: decisionHandler("DOCUMENT_REVIEW", APPROVE_OR_REJECT),
  riskReview: decisionHandler("RISK_REVIEW", APPROVE_OR_REJECT),
  eligibilityReview: decisionHandler("ELIGIBILITY_REVIEW", APPROVE_OR_REJECT),
  finalApproval: decisionHandler("FINAL_APPROVAL", APPROVE_OR_REJECT),
  disbursementReview: decisionHandler("DISBURSEMENT_REVIEW", APPROVE_OR_REJECT),
  // Reached after the borrower accepts the offer: a last fraud verdict before
  // the agreement is generated (`ED-FC01`/`ED-FC02`).
  fraudCheckPending: decisionHandler("FRAUD_REVIEW", CLEAR_OR_FLAG),
};
