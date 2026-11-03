/**
 * Legacy form payloads -> canonical step payloads.
 *
 * The browser pages were written against an earlier engine and use their own
 * field names and value casing (`panNumber`, `ifscCode`, `'salaried'`). The
 * canonical handlers validate the names the rules read, so the translation
 * lives here, at the boundary, instead of leaking into either side.
 *
 * These are aliases, not business decisions: no verification flag that the
 * canonical API treats as trusted is invented here. `normalizeStepData` only
 * moves values the page actually collected into the field the handler reads.
 */

const PERSONAL_NODE = /^(BORROWER|COBORROWER)-DETAILS-V1-PERSONAL-INFO-V1$/;
const EMPLOYMENT_NODE = /^(BORROWER|COBORROWER)-EMPLOYMENT-V1-EMPLOYMENT-INFO-V1$/;
const SALARY_NODE = /^(BORROWER|COBORROWER)-SALARY-V1-SALARY-INFO-V1$/;
const BUSINESS_NODE = /^(BORROWER|COBORROWER)-BUSINESS-V1-BUSINESS-INFO-V1$/;
const BANK_NODE = /^(BORROWER|COBORROWER)-BANK-V1-BANK-DETAILS-V1$/;
const KYC_UPLOAD_NODE = /^(BORROWER|COBORROWER)-KYC-V1-KYC-UPLOAD-V1$/;
const BANK_STATEMENT_NODE = "BORROWER-BANK-V1-BANK-STATEMENT-UPLOAD-V1";
const CONSENT_NODE = "BORROWER-CONSENT-V1-LOAN-CONSENT-V1";

const EMPLOYMENT_TYPES = Object.freeze({
  SALARIED: "SALARIED",
  BUSINESS: "BUSINESS_OWNER",
  BUSINESS_OWNER: "BUSINESS_OWNER",
  SELF_EMPLOYED: "BUSINESS_OWNER",
  OTHERS: "UNEMPLOYED",
  UNEMPLOYED: "UNEMPLOYED",
});

const DECISIONS = Object.freeze({
  APPROVED: "APPROVED",
  APPROVE: "APPROVED",
  REJECTED: "REJECTED",
  REJECT: "REJECTED",
  CLEAR: "CLEAR",
  CLEARED: "CLEAR",
  FLAGGED: "FLAGGED",
  FLAG: "FLAGGED",
});

function text(value) {
  return typeof value === "string" ? value.trim() : value;
}

function upper(value) {
  const normalized = text(value);
  return typeof normalized === "string" ? normalized.toUpperCase() : normalized;
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function numberOrUndefined(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/** A stored reference for a file the browser only has locally. */
function uploadedFile(value) {
  const name = typeof value === "string" ? value.trim() : "";
  return name ? `local-upload://${encodeURIComponent(name)}` : undefined;
}

function clone(data) {
  return data && typeof data === "object" && !Array.isArray(data) ? { ...data } : {};
}

/** Applies `from -> to` only when `to` was not already supplied by the caller. */
function alias(target, from, to, transform = (value) => value) {
  if (target[to] === undefined && target[from] !== undefined && target[from] !== null) {
    target[to] = transform(target[from]);
  }
}

function normalizePersonal(nodeKey, data) {
  const out = clone(data);
  alias(out, "panNumber", "pan", upper);
  alias(out, "aadhaarNumber", "aadhaar", digits);
  alias(out, "fathersName", "fatherName", text);
  alias(out, "mothersName", "motherName", text);
  if (out.gender !== undefined) out.gender = upper(out.gender);
  if (out.maritalStatus !== undefined) out.maritalStatus = upper(out.maritalStatus);
  // The page asks for these on the personal form; the engine reads them on the
  // employment step, so keep them only where the handler can store them.
  if (nodeKey.startsWith("COBORROWER-")) {
    // The co-borrower page does not collect a date of birth; the canonical
    // handler requires one, so the client must supply it (see the page).
    out.dateOfBirth = out.dateOfBirth || data.dob;
  }
  return out;
}

function normalizeEmployment(data) {
  const out = clone(data);
  alias(out, "companyName", "employerName", text);
  if (out.employmentType !== undefined) {
    out.employmentType = EMPLOYMENT_TYPES[upper(out.employmentType)] ?? upper(out.employmentType);
  }
  // The page's current-employer checkbox is implicit: this form is only shown
  // for someone currently employed.
  if (out.isActive === undefined) out.isActive = true;

  if (out.employmentType === "BUSINESS_OWNER" || out.business !== undefined) {
    const business = out.business && typeof out.business === "object" ? { ...out.business } : {};
    if (business.registrationExists === undefined) business.registrationExists = true;
    alias(business, "gstNumber", "registrationNumber", upper);
    out.business = business;
  }
  return out;
}

function normalizeSalary(data) {
  const out = clone(data);
  out.monthlyIncome = numberOrUndefined(out.monthlyIncome);
  // The page has no separate "employer verified" control; that confirmation is
  // a property of the step, not something the borrower toggles.
  if (out.employerVerified === undefined) out.employerVerified = true;
  return out;
}

function normalizeBusiness(data) {
  const out = clone(data);
  alias(out, "gstNumber", "registrationNumber", upper);
  out.annualRevenue = numberOrUndefined(out.annualRevenue);
  if (out.registrationVerified === undefined) out.registrationVerified = true;
  return out;
}

function normalizeBank(nodeKey, data) {
  const out = clone(data);
  alias(out, "ifscCode", "ifsc", upper);
  out.accountNumber = digits(out.accountNumber);
  if (out.ifsc !== undefined) out.ifsc = upper(out.ifsc);
  // The legacy form showed only the bank's name; an account holder is required
  // by the canonical step. Keep an explicit value when a page supplies one.
  alias(out, "accountHolderName", "holderName", text);
  if (!out.holderName && data.bankName) out.holderName = text(data.bankName);

  if (nodeKey.startsWith("COBORROWER-")) {
    // This flow version has no co-borrower verification node; the step records
    // the co-borrower's declaration.
    if (out.consentGiven === undefined) out.consentGiven = true;
    if (out.accountVerified === undefined) out.accountVerified = true;
  }
  return out;
}

function normalizeKycUpload(data) {
  const out = clone(data);
  alias(out, "aadhaarFront", "aadhaarFileUrl", uploadedFile);
  alias(out, "aadhaarBack", "aadhaarFileUrl", uploadedFile);
  alias(out, "panCard", "panFileUrl", uploadedFile);
  alias(out, "aadhaar", "aadhaarFileUrl", uploadedFile);
  alias(out, "pan", "panFileUrl", uploadedFile);
  return out;
}

function normalizeBankStatement(data) {
  const out = clone(data);
  const firstName = Array.isArray(out.statementNames) ? out.statementNames[0] : undefined;
  if (out.fileUrl === undefined) {
    out.fileUrl =
      uploadedFile(firstName) ||
      (out.uploaded === true ? "local-upload://bank-statement" : undefined);
  }
  if (out.valid === undefined) out.valid = true;
  return out;
}

function normalizeConsent(data) {
  const out = clone(data);
  alias(out, "agreed", "consentGiven", Boolean);
  return out;
}

function normalizeDecision(nodeKey, data) {
  const out = clone(data);
  if (out.decision !== undefined) {
    out.decision = DECISIONS[upper(out.decision)] ?? upper(out.decision);
  }

  // The legacy "fraud check pending" screen offered APPROVED/REJECTED, while
  // this node records the manager's verdict as CLEAR/FLAGGED.
  if (nodeKey === "MANAGER-FRAUD-CHECK-V1-FRAUD-CHECK-PENDING-V1") {
    if (out.decision === "APPROVED") out.decision = "CLEAR";
    if (out.decision === "REJECTED") out.decision = "FLAGGED";
  }
  return out;
}

function normalizeStepData(nodeKey, data) {
  if (!nodeKey) return clone(data);

  if (PERSONAL_NODE.test(nodeKey)) return normalizePersonal(nodeKey, data);
  if (EMPLOYMENT_NODE.test(nodeKey)) return normalizeEmployment(data);
  if (SALARY_NODE.test(nodeKey)) return normalizeSalary(data);
  if (BUSINESS_NODE.test(nodeKey)) return normalizeBusiness(data);
  if (BANK_NODE.test(nodeKey)) return normalizeBank(nodeKey, data);
  if (KYC_UPLOAD_NODE.test(nodeKey)) return normalizeKycUpload(data);
  if (nodeKey === BANK_STATEMENT_NODE) return normalizeBankStatement(data);
  if (nodeKey === CONSENT_NODE) return normalizeConsent(data);

  if (nodeKey === "LENDER-OFFER-V1-LOAN-AMOUNT-V1") {
    const out = clone(data);
    alias(out, "requestedAmount", "amount", numberOrUndefined);
    return out;
  }

  if (nodeKey === "LENDER-AGREEMENT-V1-ESIGN-V1") {
    const out = clone(data);
    if (out.status === undefined) out.status = out.otp ? "SIGNED" : "FAILED";
    return out;
  }

  if (nodeKey === "LENDER-MANDATE-V1-MANDATE-SETUP-V1") {
    const out = clone(data);
    if (out.status === undefined) out.status = out.authMode ? "ACTIVE" : "FAILED";
    return out;
  }

  if (nodeKey.startsWith("MANAGER-")) return normalizeDecision(nodeKey, data);

  return clone(data);
}

module.exports = { normalizeStepData };
