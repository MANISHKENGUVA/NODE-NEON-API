/**
 * Bank details and bank statement steps.
 *
 * Account number and IFSC validity are format checks derived on the server, so
 * `ED19` cannot be satisfied by simply posting `valid: true`.
 */
const v = require("../../core/validation");
const { validationFailed } = require("../../core/errors");
const { maskIdentifier } = require("../../core/hash");
const kycRepository = require("../kyc/kycRepository");
const applicantRepository = require("../applicant/applicantRepository");

const ACCOUNT_NUMBER = /^[0-9]{9,18}$/;

/**
 * `ED19` needs a well-formed account number and IFSC before the verification
 * node runs.
 *
 * The coborrower has no verification node of its own in this flow version, so
 * `ED44` reads `COBORROWER.bank.verified` straight off this step — which makes
 * `accountVerified` and `consentGiven` self-declarations for co-borrowers only.
 */
async function bankDetails({ db, application, applicant, data, role, ip }) {
  const accountNumber = v.requireMatch(
    data.accountNumber,
    "accountNumber",
    ACCOUNT_NUMBER,
    "'accountNumber' must be 9 to 18 digits"
  );
  const ifsc = v.requireMatch(
    data.ifsc,
    "ifsc",
    v.patterns.IFSC,
    "'ifsc' must be a valid IFSC (e.g. HDFC0001234)"
  );

  const account = {
    accountNumberMasked: maskIdentifier(accountNumber),
    accountNumberValid: true,
    ifsc,
    ifscValid: true,
    holderName: v.requireString(data.holderName, "holderName", { max: 160 }),
    bankName: v.optionalString(data.bankName, "bankName", { max: 120 }),
    branch: v.optionalString(data.branch, "branch", { max: 120 }),
  };

  if (role === "COBORROWER") {
    const consentGiven = v.requireBoolean(data.consentGiven, "consentGiven");
    if (!consentGiven) throw validationFailed("The co-borrower consent must be accepted");

    const accountVerified = v.requireBoolean(data.accountVerified, "accountVerified");
    if (!accountVerified) {
      throw validationFailed("'accountVerified' must be true to continue");
    }

    account.verificationStatus = "VERIFIED";
    account.verifiedAt = new Date();
  }

  const record = await kycRepository.upsertBankAccount(db, applicant.id, account);

  if (role === "COBORROWER") {
    await applicantRepository.saveConsent(db, application.id, "COBORROWER_CONSENT", {
      granted: true,
      ipAddress: ip,
    });
  }

  return {
    accountNumber: record.account_number_masked,
    ifsc: record.ifsc,
    verificationStatus: record.verification_status,
  };
}

/** `ED22` needs an uploaded statement that passed the upload check. */
async function bankStatement({ db, applicant, data }) {
  const fileUrl = v.requireString(data.fileUrl, "fileUrl", { max: 2048 });
  const valid = data.valid === undefined ? true : v.requireBoolean(data.valid, "valid");

  const record = await kycRepository.upsertBankAccount(db, applicant.id, {
    statementUploaded: true,
    statementValid: valid,
    statementFileUrl: fileUrl,
  });

  return { uploaded: record.statement_uploaded, valid: record.statement_valid };
}

module.exports = { bankDetails, bankStatement };
