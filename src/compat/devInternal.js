/**
 * Local stand-in for the trusted verification services.
 *
 * The flow definition marks face, PAN, bank, bureau, fraud, document, risk,
 * eligibility and disbursement as INTERNAL: only a service holding
 * `INTERNAL_SERVICE_TOKEN` may complete them. That is the right production
 * contract — a browser cannot certify its own KYC. It also means a local run
 * with no providers parks at the first such node forever.
 *
 * This module is the explicitly opt-in development answer (`DEV_SIMULATE_INTERNAL_STEPS`,
 * refused in production). It returns the same verdict payloads a provider
 * would, so the rule engine still takes its normal path; nothing here bypasses
 * a rule, it only supplies the missing external answer.
 */
const { config } = require("../config/env");
const { getInternalStep } = require("../workflow/systemSteps");
const { getNodeAccess, ACCESS_TYPES } = require("../workflow/accessPolicy");
const workflowService = require("../workflow/workflowService");

const VERDICTS = Object.freeze({
  "BORROWER-KYC-V1-FACE-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    score: 95,
    livenessPassed: true,
    provider: "DEV_SIMULATOR",
  }),
  "BORROWER-KYC-V1-VERIFICATION-PENDING-V1": Object.freeze({
    status: "VERIFIED",
    score: 95,
    livenessPassed: true,
    provider: "DEV_SIMULATOR",
  }),
  "BORROWER-KYC-V1-PAN-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    nameMatched: true,
    blacklisted: false,
    provider: "DEV_SIMULATOR",
  }),
  "COBORROWER-KYC-V1-FACE-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    score: 95,
    livenessPassed: true,
    provider: "DEV_SIMULATOR",
  }),
  "COBORROWER-KYC-V1-PAN-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    nameMatched: true,
    blacklisted: false,
    provider: "DEV_SIMULATOR",
  }),
  "COBORROWER-KYC-V1-AADHAR-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    mobileLinked: true,
    provider: "DEV_SIMULATOR",
  }),
  "BORROWER-BANK-V1-BANK-ACCOUNT-VERIFICATION-V1": Object.freeze({
    status: "VERIFIED",
    holderName: "DEV SIMULATED ACCOUNT",
  }),
  "BORROWER-CREDIT-V1-CREDIT-CHECK-V1": Object.freeze({
    creditScore: 750,
    consentGiven: true,
  }),
  "LENDER-CREDIT-V1-CREDIT-CHECK-V1": Object.freeze({ creditScore: 750 }),
  "LENDER-FRAUD-V1-FRAUD-CHECK-V1": Object.freeze({ status: "CLEAR" }),
  "LENDER-DOCUMENT-V1-DOCUMENT-VERIFICATION-V1": Object.freeze({ status: "VERIFIED" }),
  "LENDER-RISK-V1-RISK-ASSESSMENT-V1": Object.freeze({ riskScore: 80 }),
  "LENDER-ELIGIBILITY-V1-ELIGIBILITY-CHECK-V1": Object.freeze({ status: "ELIGIBLE" }),
  "LENDER-DISBURSEMENT-V1-DISBURSEMENT-CONFIRMATION-V1": Object.freeze({
    status: "COMPLETED",
    providerReference: "DEV-SIMULATED",
  }),
});

const MAX_STEPS = 15;

function enabled() {
  return config.dev.simulateInternalSteps && !config.isProduction;
}

/**
 * Completes every internal node the application is waiting at, until it reaches
 * an actor step, a terminal state, or a node this simulator cannot answer.
 */
async function advanceInternalSteps(applicationId, session) {
  if (!enabled()) return;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const state = await workflowService.getState(applicationId, session);
    if (state.application.status !== "IN_PROGRESS") return;

    const nodeKey = state.application.currentNode;
    const access = getNodeAccess(nodeKey);
    if (access.type !== ACCESS_TYPES.INTERNAL) return;
    if (!getInternalStep(nodeKey)) return;

    const verdict = VERDICTS[nodeKey];
    if (!verdict) return;

    try {
      await workflowService.completeInternalStep({
        applicationId,
        nodeKey,
        data: verdict,
        eventId: `dev-internal-${applicationId}-${nodeKey}`,
      });
    } catch (error) {
      // A concurrent request moved the application first; read the new node
      // and decide again instead of reporting a 409 to the browser.
      if (error?.status !== 409) throw error;
    }
  }
}

module.exports = { advanceInternalSteps, VERDICTS, enabled };
