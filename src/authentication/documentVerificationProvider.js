/**
 * documentVerificationProvider.js
 *
 * DocumentVerificationProvider — authentication method "DOCUMENT".
 *
 * Verifies the credential SERVER-SIDE against documents already on record in
 * domain_datastore for this workflow. The frontend only names WHICH document
 * type it wants to verify; the backend decides whether that document actually
 * exists and is valid in its own store.
 *
 * credential: { documentType: "AADHAAR" | "PAN" | "BANK_STATEMENT" }
 *
 * For production, replace the body of verify() with a document-integrity /
 * OCR gateway call while keeping the AuthenticationProvider interface.
 */

const { AuthenticationProvider, subjectHash } = require("./authenticationProvider");
const { buildWorkflowContext } = require("../services/domainDatastore");

const DOCUMENT_CHECKS = {
  AADHAAR: (docs) => docs.identity?.aadharUploaded === true,
  PAN: (docs) => docs.identity?.panUploaded === true,
  BANK_STATEMENT: (docs) => docs.bankStatement?.uploaded === true,
};

class DocumentVerificationProvider extends AuthenticationProvider {
  constructor() {
    super("DOCUMENT");
  }

  async verify(credential = {}, context = {}) {
    const documentType = String(credential.documentType ?? "")
      .trim()
      .toUpperCase();

    if (!Object.prototype.hasOwnProperty.call(DOCUMENT_CHECKS, documentType)) {
      return { verified: false, reason: "UNSUPPORTED_DOCUMENT_TYPE" };
    }

    if (!context.workflowId) {
      return { verified: false, reason: "WORKFLOW_CONTEXT_REQUIRED" };
    }

    const storedContext = await buildWorkflowContext(context.workflowId);
    const docs = storedContext?.DOCUMENTS ?? {};

    if (!DOCUMENT_CHECKS[documentType](docs)) {
      return { verified: false, reason: "DOCUMENT_NOT_ON_RECORD" };
    }

    return {
      verified: true,
      subjectHash: subjectHash(`${this.method}:${context.workflowId}:${documentType}`),
    };
  }
}

module.exports = { DocumentVerificationProvider };
