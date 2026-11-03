/**
 * Node → handler registry.
 *
 * This is the only place where flow node keys appear next to code. Boot
 * validation then proves the two stay in sync: every node that expects input
 * has a handler, and every handler points at a real node.
 */
const { definition, getActorForNode } = require("./definition");
const { getAutoTask, getInternalStep } = require("./systemSteps");

const applicantSteps = require("../modules/applicant/applicantSteps");
const kycSteps = require("../modules/kyc/kycSteps");
const bankingSteps = require("../modules/lending/bankingSteps");
const lendingSteps = require("../modules/lending/lendingSteps");
const reviewSteps = require("../modules/manager/reviewSteps");

const ACTOR_STEPS = Object.freeze({
  // Borrower — identity, employment and documents
  "BORROWER-DETAILS-V1-PERSONAL-INFO-V1": applicantSteps.personalInfo,
  "BORROWER-ADDRESS-V1-ADDRESS-INFO-V1": applicantSteps.address,
  "BORROWER-KYC-V1-KYC-UPLOAD-V1": kycSteps.kycUpload,
  "BORROWER-KYC-V1-AADHAR-VERIFICATION-V1": kycSteps.aadhaarVerification,
  "BORROWER-EMPLOYMENT-V1-EMPLOYMENT-INFO-V1": applicantSteps.employment,
  "BORROWER-SALARY-V1-SALARY-INFO-V1": applicantSteps.salary,
  "BORROWER-BUSINESS-V1-BUSINESS-INFO-V1": applicantSteps.business,
  "BORROWER-BANK-V1-BANK-DETAILS-V1": bankingSteps.bankDetails,
  "BORROWER-BANK-V1-BANK-STATEMENT-UPLOAD-V1": bankingSteps.bankStatement,
  "BORROWER-DOCUMENT-V1-DOCUMENT-UPLOAD-V1": applicantSteps.documentUpload,
  "BORROWER-CONSENT-V1-LOAN-CONSENT-V1": applicantSteps.consent,

  // Co-borrower — same shape, own rows
  "COBORROWER-DETAILS-V1-PERSONAL-INFO-V1": applicantSteps.personalInfo,
  "COBORROWER-ADDRESS-V1-ADDRESS-INFO-V1": applicantSteps.address,
  "COBORROWER-KYC-V1-KYC-UPLOAD-V1": kycSteps.kycUpload,
  "COBORROWER-EMPLOYMENT-V1-EMPLOYMENT-INFO-V1": applicantSteps.employment,
  "COBORROWER-SALARY-V1-SALARY-INFO-V1": applicantSteps.salary,
  "COBORROWER-BUSINESS-V1-BUSINESS-INFO-V1": applicantSteps.business,
  "COBORROWER-BANK-V1-BANK-DETAILS-V1": bankingSteps.bankDetails,

  // Lender
  "LENDER-OFFER-V1-LOAN-AMOUNT-V1": lendingSteps.loanAmount,
  "LENDER-OFFER-V1-LOAN-OFFER-V1": lendingSteps.loanOffer,
  "LENDER-AGREEMENT-V1-ESIGN-V1": lendingSteps.esign,
  "LENDER-MANDATE-V1-MANDATE-SETUP-V1": lendingSteps.mandate,
  "LENDER-DISBURSEMENT-V1-DISBURSEMENT-FAILED-V1": lendingSteps.disbursementFailed,

  // Manager
  "MANAGER-REVIEW-V1-CREDIT-EXCEPTION-V1": reviewSteps.creditException,
  "MANAGER-REVIEW-V1-FRAUD-REVIEW-V1": reviewSteps.fraudReview,
  "MANAGER-REVIEW-V1-DOCUMENT-REVIEW-V1": reviewSteps.documentReview,
  "MANAGER-REVIEW-V1-RISK-REVIEW-V1": reviewSteps.riskReview,
  "MANAGER-REVIEW-V1-ELIGIBILITY-REVIEW-V1": reviewSteps.eligibilityReview,
  "MANAGER-FRAUD-CHECK-V1-FRAUD-CHECK-PENDING-V1": reviewSteps.fraudCheckPending,
  "MANAGER-APPROVAL-V1-FINAL-APPROVAL-V1": reviewSteps.finalApproval,
  "MANAGER-APPROVAL-V1-DISBURSEMENT-REVIEW-V1": reviewSteps.disbursementReview,
});

/** Handler for a node an actor completes, or null. */
function getActorStep(nodeKey) {
  return Object.prototype.hasOwnProperty.call(ACTOR_STEPS, nodeKey) ? ACTOR_STEPS[nodeKey] : null;
}

/** True when a node waits for input (as opposed to TERMINAL / WAIT). */
function expectsInput(state) {
  return state?.type === "FORM" || state?.access?.type === "ACTOR";
}

/**
 * A SYSTEM node is normally completed by an automatic task or a trusted service
 * call. The exception is a SYSTEM node whose access block says ACTOR — the
 * actor drives it (for example Aadhaar verification, where the applicant proves
 * ownership through an OTP challenge and the system then records the result).
 */
function isActorDriven(state) {
  return state?.access?.type === "ACTOR";
}

/**
 * Fails the boot when the registry and the flow definition disagree.
 * A missing handler would otherwise surface as a 500 in the middle of a loan.
 */
function assertRegistryComplete() {
  const problems = [];

  for (const [nodeKey, state] of Object.entries(definition.states)) {
    const hasActorStep = Boolean(getActorStep(nodeKey));
    const hasSystemPath = Boolean(getAutoTask(nodeKey)) || Boolean(getInternalStep(nodeKey));

    if (expectsInput(state) && !hasActorStep && !hasSystemPath) {
      problems.push(`node '${nodeKey}' expects input but has no handler`);
    }
    if (state.type === "SYSTEM" && !isActorDriven(state) && !hasSystemPath) {
      problems.push(`system node '${nodeKey}' has no automatic or internal handler`);
    }
    if (hasActorStep && !getActorForNode(nodeKey)) {
      problems.push(`node '${nodeKey}' has a handler but no actor`);
    }
  }

  for (const nodeKey of Object.keys(ACTOR_STEPS)) {
    if (!definition.states[nodeKey]) {
      problems.push(`handler registered for unknown node '${nodeKey}'`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Step registry does not match the flow definition:\n- ${problems.join("\n- ")}`);
  }
}

module.exports = { ACTOR_STEPS, getActorStep, assertRegistryComplete, expectsInput };
