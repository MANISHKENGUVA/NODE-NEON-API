/**
 * identityProvider.js
 *
 * IdentityProvider — authentication method "IDENTITY".
 *
 * Verifies the credential SERVER-SIDE against records the backend already
 * holds for this workflow (domain_datastore PERSONALDETAILS). A frontend
 * claim alone can never authenticate — the submitted identity must match the
 * stored record.
 *
 * credential: { panNumber: "ABCDE1234F" }
 *
 * For production, replace the body of verify() with a call to an external
 * KYC/identity gateway while keeping the AuthenticationProvider interface.
 */

const { AuthenticationProvider, subjectHash } = require("./authenticationProvider");
const { buildWorkflowContext } = require("../services/domainDatastore");

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

class IdentityProvider extends AuthenticationProvider {
  constructor() {
    super("IDENTITY");
  }

  async verify(credential = {}, context = {}) {
    const pan = String(credential.panNumber ?? credential.pan ?? "")
      .trim()
      .toUpperCase();

    if (!PAN_PATTERN.test(pan)) {
      return { verified: false, reason: "INVALID_FORMAT" };
    }

    if (!context.workflowId) {
      return { verified: false, reason: "WORKFLOW_CONTEXT_REQUIRED" };
    }

    // Server-side record lookup — the backend is authoritative.
    const storedContext = await buildWorkflowContext(context.workflowId);
    const storedPan = storedContext?.PERSONALDETAILS?.panNumber;

    if (!storedPan || String(storedPan).trim().toUpperCase() !== pan) {
      return { verified: false, reason: "NO_MATCHING_RECORD" };
    }

    return { verified: true, subjectHash: subjectHash(`${this.method}:${pan}`) };
  }
}

module.exports = { IdentityProvider };
