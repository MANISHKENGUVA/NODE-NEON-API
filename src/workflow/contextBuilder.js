/**
 * Workflow context builder.
 *
 * Pure mapping: typed database rows in, the nested object the rule engine
 * reads out. Keeping this pure means the whole rule surface can be tested
 * without a database.
 *
 * Every field is derived on the server. Nothing here copies a client-supplied
 * "verified" flag; verification states come from columns that only trusted
 * services write.
 */

/** Documents that must be present before the document step can complete. */
const REQUIRED_DOCUMENTS = Object.freeze(["AADHAAR", "PAN"]);

const emptyToNull = (value) => (value === undefined ? null : value);

// Employment types are stored upper case (like every other enum) but the flow
// definition compares them in lower case.
const lowerOrNull = (value) =>
  value === undefined || value === null ? null : String(value).toLowerCase();

// Applicants under this age are not a fixable form error; the flow routes them
// to the rejection node instead. Kept in sync with the applicant step's minimum.
const MINIMUM_AGE = 18;

/** Whole years between `value` (a stored date of birth) and today, or null. */
function ageInYears(value) {
  if (!value) return null;
  const dob = new Date(value);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function isUploaded(documents, docType) {
  return Boolean(documents?.[docType]?.file_url);
}

function buildAddress(address) {
  if (!address) return {};
  return {
    flatNo: address.flat_no,
    building: address.building,
    street: address.street,
    landmark: address.landmark,
    city: address.city,
    district: address.district,
    state: address.state,
    pincode: address.pincode,
    country: address.country,
    residenceType: address.residence_type,
    isValid: address.is_valid === true,
    pincodeVerified: address.pincode_verified === true,
  };
}

function buildDocuments(documents, bank, credit) {
  const anyInvalid = REQUIRED_DOCUMENTS.some(
    (docType) => documents?.[docType]?.is_valid === false
  );
  const allPresent = REQUIRED_DOCUMENTS.every((docType) => isUploaded(documents, docType));

  return {
    identity: {
      aadharUploaded: isUploaded(documents, "AADHAAR"),
      panUploaded: isUploaded(documents, "PAN"),
    },
    bankStatement: {
      uploaded: bank?.statement_uploaded === true,
      valid: bank?.statement_valid === true,
    },
    requiredDocuments: {
      completed: allPresent && !anyInvalid,
      invalid: anyInvalid,
    },
    verification: {
      status: credit?.document_verification_status ?? "PENDING",
    },
  };
}

function buildKyc(kyc) {
  const pan = kyc?.PAN ?? null;
  const aadhaar = kyc?.AADHAAR ?? null;
  const face = kyc?.FACE ?? null;

  return {
    pan: {
      status: pan?.status ?? "PENDING",
      nameMatched: pan?.name_matched ?? null,
      blacklisted: pan?.blacklisted ?? null,
    },
    aadhar: {
      status: aadhaar?.status ?? "PENDING",
      mobileLinked: aadhaar?.mobile_linked ?? null,
    },
    faceVerification: {
      status: face?.status ?? "PENDING",
      matchScore: face?.score === null || face?.score === undefined ? null : Number(face.score),
      livenessPassed: face?.liveness_passed ?? null,
    },
  };
}

function buildEmployment(employment) {
  return {
    employmentType: lowerOrNull(employment?.employment_type),
    currentCompany: {
      name: employment?.employer_name ?? null,
      designation: employment?.designation ?? null,
      workingSince: employment?.working_since ?? null,
      isActive: employment?.is_active === true,
    },
    salary: {
      monthlyIncome:
        employment?.monthly_income === null || employment?.monthly_income === undefined
          ? null
          : Number(employment.monthly_income),
      companyVerified: employment?.employer_verified === true,
    },
  };
}

function buildBusiness(business) {
  return {
    registration: {
      exists: business?.registration_exists === true,
      isVerified: business?.registration_verified === true,
      regNumber: business?.registration_number ?? null,
    },
    financials: {
      annualRevenue:
        business?.annual_revenue === null || business?.annual_revenue === undefined
          ? null
          : Number(business.annual_revenue),
    },
  };
}

function buildBank(bank) {
  if (!bank) {
    return {
      accountNumber: { number: null, valid: false },
      ifsc: { code: null, valid: false },
      verification: { status: "PENDING", verifiedAt: null },
      accountHolderName: null,
      bankName: null,
      branch: null,
    };
  }

  return {
    accountNumber: { number: bank.account_number_masked, valid: bank.account_number_valid === true },
    ifsc: { code: bank.ifsc, valid: bank.ifsc_valid === true },
    verification: { status: bank.verification_status ?? "PENDING", verifiedAt: bank.verified_at },
    accountHolderName: bank.holder_name,
    bankName: bank.bank_name,
    branch: bank.branch,
  };
}

function buildCoborrower(dataset) {
  if (!dataset.coborrower) return undefined;

  const documents = dataset.coborrowerDocuments ?? {};
  const kyc = buildKyc(dataset.coborrowerKyc);
  const bank = dataset.coborrowerBank;

  return {
    personalInfo: {
      completed: Boolean(
        dataset.coborrower.full_name &&
          dataset.coborrower.date_of_birth &&
          dataset.coborrower.pan_hash
      ),
    },
    address: { isValid: dataset.coborrowerAddress?.is_valid === true },
    documents: {
      aadharUploaded: isUploaded(documents, "AADHAAR"),
      panUploaded: isUploaded(documents, "PAN"),
    },
    kyc: {
      pan: { status: kyc.pan.status },
      aadhar: { status: kyc.aadhar.status },
      faceMatchScore: kyc.faceVerification.matchScore,
      livenessPassed: kyc.faceVerification.livenessPassed,
    },
    employment: { type: lowerOrNull(dataset.coborrowerEmployment?.employment_type) },
    salary: {
      monthlyIncome:
        dataset.coborrowerEmployment?.monthly_income === null ||
        dataset.coborrowerEmployment?.monthly_income === undefined
          ? null
          : Number(dataset.coborrowerEmployment.monthly_income),
    },
    business: {
      registrationVerified: dataset.coborrowerBusiness?.registration_verified === true,
    },
    bank: { verified: bank?.verification_status === "VERIFIED" },
    consent: { completed: dataset.consents?.COBORROWER_CONSENT?.granted === true },
  };
}

function buildManager(decisions) {
  const decision = (type) => {
    const row = decisions?.[type];
    if (!row) return { decision: null, remarks: null, reviewedAt: null };
    return { decision: row.decision, remarks: row.remarks, reviewedAt: row.decided_at };
  };

  return {
    creditException: decision("CREDIT_EXCEPTION"),
    fraudReview: decision("FRAUD_REVIEW"),
    documentReview: decision("DOCUMENT_REVIEW"),
    riskReview: decision("RISK_REVIEW"),
    eligibilityReview: decision("ELIGIBILITY_REVIEW"),
    finalApproval: decision("FINAL_APPROVAL"),
    disbursementReview: decision("DISBURSEMENT_REVIEW"),
  };
}

/**
 * @param {object} application  loan_applications row
 * @param {object} dataset      rows loaded by applicationRepository.loadWorkflowDataset
 * @returns {object} rule-engine context
 */
function buildWorkflowContext(application, dataset) {
  const borrower = dataset.borrower;
  const employment = dataset.borrowerEmployment;
  const business = dataset.borrowerBusiness;
  const bank = dataset.borrowerBank;
  const documents = dataset.borrowerDocuments ?? {};
  const credit = dataset.credit;
  const offer = dataset.offer;
  const disbursement = dataset.disbursement;
  const consent = dataset.consents?.BORROWER_CONSENT;
  const kyc = buildKyc(dataset.borrowerKyc);
  const borrowerAge = ageInYears(borrower?.date_of_birth);

  const context = {
    APPLICATION: {
      currentStep: application.current_node,
      status: application.status,
      requiresCoborrower: application.requires_coborrower === true,
      requestedAmount: emptyToNull(application.requested_amount),
    },
    PERSONALDETAILS: {
      fullName: borrower?.full_name ?? null,
      fathersName: borrower?.father_name ?? null,
      mothersName: borrower?.mother_name ?? null,
      dateOfBirth: borrower?.date_of_birth ?? null,
      gender: borrower?.gender ?? null,
      maritalStatus: borrower?.marital_status ?? null,
      email: borrower?.email ?? null,
      mobileNumber: borrower?.mobile_number ?? null,
      loanPurpose: borrower?.loan_purpose ?? null,
      // Server-derived: the identity block is complete when the mandatory
      // fields are stored, not because a client said so.
      basicInfoCompleted: Boolean(
        borrower?.full_name && borrower?.date_of_birth && borrower?.pan_hash && borrower?.mobile_number
      ),
      // Server-derived eligibility: an under-18 borrower is routed to the
      // rejection node by the flow definition instead of blocking the form.
      isMinor: borrowerAge !== null && borrowerAge < MINIMUM_AGE,
      financialStatus: {
        employmentType: lowerOrNull(employment?.employment_type),
        monthlyIncome:
          employment?.monthly_income === null || employment?.monthly_income === undefined
            ? null
            : Number(employment.monthly_income),
        blacklistedEmployer: employment?.employer_blacklisted === true,
      },
    },
    ADDRESS: { current: buildAddress(dataset.borrowerAddress) },
    DOCUMENTS: buildDocuments(documents, bank, credit),
    KYC: kyc,
    EMPLOYMENT: buildEmployment(employment),
    BUSINESS: buildBusiness(business),
    BANK: buildBank(bank),
    CONSENT: {
      borrowerConsent: consent?.granted === true,
      consentedAt: consent?.granted_at ?? null,
    },
    CREDIT: {
      borrower: {
        score: credit?.credit_score === null || credit?.credit_score === undefined
          ? null
          : Number(credit.credit_score),
        consentGiven: credit?.consent_given === true,
      },
    },
    FINANCIALDETAILS: {
      creditData: {
        creditScore:
          credit?.credit_score === null || credit?.credit_score === undefined
            ? null
            : Number(credit.credit_score),
      },
    },
    RISK: {
      score: credit?.risk_score === null || credit?.risk_score === undefined
        ? null
        : Number(credit.risk_score),
    },
    FRAUD: { status: credit?.fraud_status ?? "PENDING" },
    FRAUDCHECK: {
      status: dataset.decisions?.FRAUD_REVIEW?.decision ?? credit?.fraud_status ?? "PENDING",
    },
    ELIGIBILITY: { status: credit?.eligibility_status ?? "PENDING" },
    MANAGER: buildManager(dataset.decisions),
    APPROVAL: { managerDecision: dataset.decisions?.FINAL_APPROVAL?.decision ?? null },
    LOAN: {
      requestedAmount: {
        amount: emptyToNull(application.requested_amount),
        valid: application.requested_amount_valid === true,
      },
    },
    OFFER: {
      borrowerAccepted: offer?.borrower_accepted === true,
      interestRate: {
        rate: offer?.interest_rate === null || offer?.interest_rate === undefined
          ? null
          : Number(offer.interest_rate),
        calculated: offer?.interest_rate_calculated === true,
      },
    },
    AGREEMENT: {
      generated: offer?.agreement_generated === true,
      esign: { status: offer?.esign_status ?? "PENDING" },
    },
    MANDATE: { status: offer?.mandate_status ?? "PENDING" },
    DISBURSEMENT: {
      status: disbursement?.status ?? "NONE",
      request: { status: disbursement?.request_status ?? "NONE" },
      retryAllowed: disbursement?.retry_allowed === true,
    },
  };

  const coborrower = buildCoborrower(dataset);
  if (coborrower) context.COBORROWER = coborrower;

  return context;
}

module.exports = { REQUIRED_DOCUMENTS, buildWorkflowContext };
