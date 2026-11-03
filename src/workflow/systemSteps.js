/**
 * System nodes.
 *
 * Two kinds live here, and the difference matters:
 *
 *  AUTO   — deterministic lender computations the server can do by itself
 *           (interest rate, agreement generation, disbursement request). The
 *           engine runs these inline right after an actor's step.
 *
 *  INTERNAL — verdicts that must come from a trusted service (face match, PAN
 *           lookup, penny-drop, bureau score, fraud, document, risk and
 *           eligibility checks). No browser can complete these; only a caller
 *           holding `INTERNAL_SERVICE_TOKEN` can, and until it does the
 *           application waits at that node.
 *
 * Nothing here trusts a client-supplied "verified" flag.
 */
const { config } = require("../config/env");
const v = require("../core/validation");
const { validationFailed, conflict } = require("../core/errors");
const kycRepository = require("../modules/kyc/kycRepository");
const lendingRepository = require("../modules/lending/lendingRepository");

const FACE_PASS_SCORE = 80;

// ── Automatic tasks ─────────────────────────────────────────────────────────

/** Rate tiers by bureau score (`ED61` only needs the flag). */
function interestRateFor(creditScore) {
  if (creditScore === null || creditScore === undefined) return 14;
  if (creditScore >= 750) return 10.5;
  if (creditScore >= 700) return 11.5;
  if (creditScore >= 650) return 12.5;
  return 14;
}

const AUTO_TASKS = Object.freeze({
  "LENDER-OFFER-V1-INTEREST-RATE-V1": async ({ db, application }) => {
    const assessment = await lendingRepository.findCreditAssessment(db, application.id);
    const rate = interestRateFor(assessment?.credit_score ?? null);

    await lendingRepository.upsertOffer(db, application.id, {
      interestRate: rate,
      interestRateCalculated: true,
    });

    return { interestRate: rate };
  },

  "LENDER-AGREEMENT-V1-AGREEMENT-GENERATION-V1": async ({ db, application }) => {
    await lendingRepository.upsertOffer(db, application.id, {
      agreementGenerated: true,
      agreementGeneratedAt: new Date(),
    });

    return { agreementGenerated: true };
  },

  "LENDER-DISBURSEMENT-V1-DISBURSEMENT-REQUEST-V1": async ({ db, application }) => {
    const amount = application.requested_amount === null
      ? null
      : Number(application.requested_amount);

    if (amount === null) {
      throw conflict("NO_LOAN_AMOUNT", "The loan amount must be set before disbursement");
    }

    const requestStatus =
      amount > config.disbursement.manualReviewThreshold ? "MANUAL_REVIEW" : "SUBMITTED";

    const disbursement = await lendingRepository.insertDisbursement(db, application.id, {
      status: "REQUESTED",
      requestStatus,
      amount,
    });

    return { requestStatus, amount: Number(disbursement.amount) };
  },
});

// ── Internal (trusted service) steps ────────────────────────────────────────

/**
 * `ED05` passes at >= 80 with liveness. A "verified" verdict that does not
 * meet that bar is stored as FAILED so the engine always has a path.
 */
async function faceVerification({ db, applicant, data }) {
  const status = v.requireEnum(data.status, "status", ["VERIFIED", "FAILED", "PENDING"]);

  if (status === "PENDING") {
    await kycRepository.upsertKycCheck(db, applicant.id, "FACE", { status });
    return { status, pending: true };
  }

  const score = v.requireNumber(data.score, "score", { min: 0, max: 100 });
  const livenessPassed = v.requireBoolean(data.livenessPassed, "livenessPassed");
  const passed = status === "VERIFIED" && score >= FACE_PASS_SCORE && livenessPassed;

  const check = await kycRepository.upsertKycCheck(db, applicant.id, "FACE", {
    status: passed ? "VERIFIED" : "FAILED",
    score,
    livenessPassed,
    provider: v.optionalString(data.provider, "provider", { max: 60 }),
    reference: v.optionalString(data.reference, "reference", { max: 120 }),
  });

  return { status: check.status, score: Number(check.score), livenessPassed: check.liveness_passed };
}

/**
 * `ED08` needs a verified PAN whose name matches. A verified PAN with a name
 * mismatch cannot satisfy `ED08` or `ED09`, so it is recorded as FAILED.
 */
async function panVerification({ db, applicant, data }) {
  const status = v.requireEnum(data.status, "status", ["VERIFIED", "FAILED", "PENDING"]);
  const nameMatched = v.requireBoolean(data.nameMatched, "nameMatched");
  const blacklisted = data.blacklisted === undefined ? false : v.requireBoolean(data.blacklisted, "blacklisted");

  const effective = status === "VERIFIED" && nameMatched && !blacklisted ? "VERIFIED" : "FAILED";

  const check = await kycRepository.upsertKycCheck(db, applicant.id, "PAN", {
    status: effective,
    nameMatched,
    blacklisted,
    provider: v.optionalString(data.provider, "provider", { max: 60 }),
    reference: v.optionalString(data.reference, "reference", { max: 120 }),
  });

  return { status: check.status, nameMatched: check.name_matched, blacklisted: check.blacklisted };
}

/** `ED36` needs a verified Aadhaar; `ED37` rejects a failed one. */
async function aadhaarResultVerification({ db, applicant, data }) {
  const status = v.requireEnum(data.status, "status", ["VERIFIED", "FAILED"]);
  const mobileLinked = v.requireBoolean(data.mobileLinked, "mobileLinked");

  const effective = status === "VERIFIED" && mobileLinked ? "VERIFIED" : "FAILED";

  const check = await kycRepository.upsertKycCheck(db, applicant.id, "AADHAAR", {
    status: effective,
    mobileLinked,
    provider: v.optionalString(data.provider, "provider", { max: 60 }),
    reference: v.optionalString(data.reference, "reference", { max: 120 }),
  });

  return { status: check.status, mobileLinked: check.mobile_linked };
}

/** `ED20`/`ED21` read the penny-drop result. */
async function bankAccountVerification({ db, applicant, data }) {
  const status = v.requireEnum(data.status, "status", ["VERIFIED", "FAILED"]);

  const account = await kycRepository.upsertBankAccount(db, applicant.id, {
    verificationStatus: status,
    verifiedAt: new Date(),
    holderName: v.optionalString(data.holderName, "holderName", { max: 160 }),
    bankName: v.optionalString(data.bankName, "bankName", { max: 120 }),
    branch: v.optionalString(data.branch, "branch", { max: 120 }),
  });

  return { status: account.verification_status };
}

/** `ED44A` needs the borrower's consent on the bureau pull. */
async function borrowerCreditCheck({ db, application, data }) {
  const creditScore = v.requireNumber(data.creditScore, "creditScore", { min: 0, max: 1000 });
  const consentGiven = v.requireBoolean(data.consentGiven, "consentGiven");

  if (!consentGiven) {
    throw validationFailed("A credit bureau pull requires the borrower's consent");
  }

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    creditScore,
    consentGiven,
  });

  return { creditScore: assessment.credit_score, consentGiven: assessment.consent_given };
}

/** `ED45`/`ED46`/`ED47` branch on the score. */
async function lenderCreditCheck({ db, application, data }) {
  const creditScore = v.requireNumber(data.creditScore, "creditScore", { min: 0, max: 1000 });

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    creditScore,
  });

  return { creditScore: assessment.credit_score };
}

/** `ED48`/`ED49`/`ED50` branch on the fraud verdict. */
async function fraudCheck({ db, application, data }) {
  const fraudStatus = v.requireEnum(data.status, "status", ["CLEAR", "REVIEW", "CONFIRMED"]);

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    fraudStatus,
  });

  return { fraudStatus: assessment.fraud_status };
}

/** `ED51`/`ED52`/`ED53` branch on the document verdict, including REVIEW. */
async function documentVerification({ db, application, data }) {
  const status = v.requireEnum(data.status, "status", ["VERIFIED", "REVIEW", "FAILED"]);

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    documentVerificationStatus: status,
  });

  return { documentVerificationStatus: assessment.document_verification_status };
}

/** `ED54`/`ED55`/`ED56` branch on the risk score. */
async function riskAssessment({ db, application, data }) {
  const riskScore = v.requireNumber(data.riskScore, "riskScore", { min: 0, max: 100 });

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    riskScore,
  });

  return { riskScore: assessment.risk_score };
}

/** `ED57`/`ED58`/`ED59` branch on the eligibility verdict. */
async function eligibilityCheck({ db, application, data }) {
  const status = v.requireEnum(data.status, "status", ["ELIGIBLE", "EXCEPTION", "INELIGIBLE"]);

  const assessment = await lendingRepository.upsertCreditAssessment(db, application.id, {
    eligibilityStatus: status,
  });

  return { eligibilityStatus: assessment.eligibility_status };
}

/** `ED84`/`ED85` read the payment provider's outcome. */
async function disbursementConfirmation({ db, application, data }) {
  const status = v.requireEnum(data.status, "status", ["COMPLETED", "FAILED"]);

  const disbursement = await lendingRepository.updateLatestDisbursement(db, application.id, {
    status,
    providerReference: v.optionalString(data.providerReference, "providerReference", {
      max: 120,
    }),
    failureReason: v.optionalString(data.failureReason, "failureReason", { max: 500 }),
    retryAllowed: status === "FAILED" ? data.retryAllowed === true : false,
  });

  if (!disbursement) {
    throw conflict("NO_DISBURSEMENT", "There is no disbursement attempt to confirm");
  }

  return { status: disbursement.status, retryAllowed: disbursement.retry_allowed };
}

const INTERNAL_STEPS = Object.freeze({
  "BORROWER-KYC-V1-FACE-VERIFICATION-V1": faceVerification,
  "BORROWER-KYC-V1-PAN-VERIFICATION-V1": panVerification,
  "COBORROWER-KYC-V1-FACE-VERIFICATION-V1": faceVerification,
  "COBORROWER-KYC-V1-PAN-VERIFICATION-V1": panVerification,
  "COBORROWER-KYC-V1-AADHAR-VERIFICATION-V1": aadhaarResultVerification,
  "BORROWER-BANK-V1-BANK-ACCOUNT-VERIFICATION-V1": bankAccountVerification,
  "BORROWER-CREDIT-V1-CREDIT-CHECK-V1": borrowerCreditCheck,
  "LENDER-CREDIT-V1-CREDIT-CHECK-V1": lenderCreditCheck,
  "LENDER-FRAUD-V1-FRAUD-CHECK-V1": fraudCheck,
  "LENDER-DOCUMENT-V1-DOCUMENT-VERIFICATION-V1": documentVerification,
  "LENDER-RISK-V1-RISK-ASSESSMENT-V1": riskAssessment,
  "LENDER-ELIGIBILITY-V1-ELIGIBILITY-CHECK-V1": eligibilityCheck,
  "LENDER-DISBURSEMENT-V1-DISBURSEMENT-CONFIRMATION-V1": disbursementConfirmation,

  // WAIT node: the face provider answered PENDING, so ED07 parked the
  // application here. The late verdict is recorded by the same handler, and
  // ED07A / ED07B continue from it.
  "BORROWER-KYC-V1-VERIFICATION-PENDING-V1": faceVerification,
});

function getAutoTask(nodeKey) {
  return AUTO_TASKS[nodeKey] ?? null;
}

function getInternalStep(nodeKey) {
  return INTERNAL_STEPS[nodeKey] ?? null;
}

module.exports = { getAutoTask, getInternalStep, AUTO_TASKS, INTERNAL_STEPS, interestRateFor };
