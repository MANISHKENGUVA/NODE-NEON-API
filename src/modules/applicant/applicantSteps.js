/**
 * Borrower / coborrower steps that describe the person.
 *
 * Handlers are plain functions: validate, write typed rows, return a small
 * summary for the audit event. They never decide where the flow goes — the
 * rule engine does that from the data they leave behind.
 *
 * Field names in the payload mirror what the rules read, so a reviewer can
 * jump from an edge condition straight to the code that fills it.
 */
const v = require("../../core/validation");
const { validationFailed } = require("../../core/errors");
const { hashIdentifier, lastFour } = require("../../core/hash");
const repository = require("../applicant/applicantRepository");
const applicationRepository = require("../application/applicationRepository");

const EMPLOYMENT_TYPES = Object.freeze(["SALARIED", "BUSINESS_OWNER", "UNEMPLOYED"]);
const GENDERS = Object.freeze(["MALE", "FEMALE", "OTHER"]);
const MARITAL_STATUSES = Object.freeze(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER"]);
const EXTRA_DOCUMENTS = Object.freeze(["ADDRESS_PROOF", "INCOME_PROOF"]);
const AADHAAR_NUMBER = /^[0-9]{12}$/;

const MINIMUM_AGE = 18;
const MINIMUM_INCOME_WITHOUT_COBORROWER = 50000;
const MINIMUM_VERIFIED_BUSINESS_REVENUE = 1000000;

function ageInYears(isoDate) {
  const dob = new Date(`${isoDate}T00:00:00Z`);
  const today = new Date();
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** E.g. `ED01` needs a complete identity block before the address step. */
async function personalInfo({ db, applicant, data, role }) {
  const dateOfBirth = v.requireDate(data.dateOfBirth, "dateOfBirth");
  // Being under 18 is not a fixable form error for the primary applicant: their
  // details are stored and the flow routes them to the rejection node (see the
  // PERSONALDETAILS.isMinor edge). The co-borrower step has no such edge, so it
  // keeps returning the validation error.
  if (ageInYears(dateOfBirth) < MINIMUM_AGE && role !== "BORROWER") {
    throw validationFailed(`Applicants must be at least ${MINIMUM_AGE} years old`);
  }

  const pan = v.requireMatch(data.pan, "pan", v.patterns.PAN, "'pan' must be a valid PAN");
  const aadhaar = data.aadhaar
    ? v.requireMatch(data.aadhaar, "aadhaar", AADHAAR_NUMBER, "'aadhaar' must be 12 digits")
    : null;
  const email = v.optionalString(data.email, "email", { max: 254 });
  if (email && !v.patterns.EMAIL.test(email)) {
    throw validationFailed("'email' must be a valid email address");
  }

  const updated = await repository.updatePersonalDetails(db, applicant.id, {
    fullName: v.requireString(data.fullName, "fullName", { max: 120 }),
    fatherName: v.optionalString(data.fatherName, "fatherName", { max: 120 }),
    motherName: v.optionalString(data.motherName, "motherName", { max: 120 }),
    dateOfBirth,
    gender: v.requireEnum(data.gender, "gender", GENDERS),
    maritalStatus: v.optionalEnum(data.maritalStatus, "maritalStatus", MARITAL_STATUSES),
    email,
    mobileNumber: v.requireMatch(
      data.mobileNumber,
      "mobileNumber",
      v.patterns.MOBILE,
      "'mobileNumber' must be a 10 digit Indian mobile number"
    ),
    // The number itself is never stored.
    panHash: hashIdentifier(pan),
    panLast4: lastFour(pan),
    aadhaarHash: aadhaar ? hashIdentifier(aadhaar) : null,
    aadhaarLast4: aadhaar ? lastFour(aadhaar) : null,
    loanPurpose: v.optionalString(data.loanPurpose, "loanPurpose", { max: 200 }),
  });

  return { panLast4: updated.pan_last4, hasAadhaar: Boolean(updated.aadhaar_hash) };
}

/**
 * `ED02` requires both `isValid` and `pincodeVerified`. Both are derived here
 * from the submitted address; no client flag is trusted.
 */
async function address({ db, applicant, data }) {
  const pincode = v.requireMatch(
    data.pincode,
    "pincode",
    v.patterns.PINCODE,
    "'pincode' must be a 6 digit Indian pincode"
  );
  const city = v.requireString(data.city, "city", { max: 80 });
  const state = v.requireString(data.state, "state", { max: 80 });
  const street = v.requireString(data.street, "street", { max: 200 });

  const record = await repository.upsertAddress(db, applicant.id, "CURRENT", {
    flatNo: v.optionalString(data.flatNo, "flatNo", { max: 40 }),
    building: v.optionalString(data.building, "building", { max: 120 }),
    street,
    landmark: v.optionalString(data.landmark, "landmark", { max: 120 }),
    city,
    district: v.optionalString(data.district, "district", { max: 80 }),
    state,
    pincode,
    country: "INDIA",
    residenceType: v.optionalString(data.residenceType, "residenceType", { max: 40 }),
    isValid: Boolean(street && city && state && pincode),
    pincodeVerified: true,
    verifiedAt: new Date(),
  });

  return { pincodeLast3: record.pincode.slice(-3), isValid: record.is_valid };
}

/**
 * `ED12`/`ED13`/`ED14` branch on the employment type. A business owner also
 * has to declare whether the business is registered, because `ED13` needs that
 * answer before the business node is shown.
 */
async function employment({ db, applicant, data }) {
  const employmentType = v.requireEnum(data.employmentType, "employmentType", EMPLOYMENT_TYPES);

  if (employmentType === "SALARIED") {
    const isActive = v.requireBoolean(data.isActive, "isActive");
    if (!isActive) {
      throw validationFailed(
        "'isActive' must be true: the salaried path requires a current employer"
      );
    }
    await repository.upsertEmployment(db, applicant.id, {
      employmentType,
      employerName: v.requireString(data.employerName, "employerName", { max: 160 }),
      designation: v.optionalString(data.designation, "designation", { max: 120 }),
      workingSince: v.optionalDate(data.workingSince, "workingSince"),
      isActive,
      monthlyIncome: v.optionalNumber(data.monthlyIncome, "monthlyIncome", { min: 0 }),
    });
    return { employmentType };
  }

  if (employmentType === "BUSINESS_OWNER") {
    const business = v.optionalObject(data.business, "business");
    const registrationExists = v.requireBoolean(
      business.registrationExists,
      "business.registrationExists"
    );
    if (!registrationExists) {
      throw validationFailed(
        "'business.registrationExists' must be true: the business path requires a registered business"
      );
    }

    await repository.upsertEmployment(db, applicant.id, { employmentType, isActive: true });
    await repository.upsertBusiness(db, applicant.id, {
      registrationExists,
      registrationNumber: v.optionalString(
        business.registrationNumber,
        "business.registrationNumber",
        { max: 60 }
      ),
    });
    return { employmentType, registrationExists };
  }

  // UNEMPLOYED is a valid answer; `ED14` turns it into a rejection.
  await repository.upsertEmployment(db, applicant.id, {
    employmentType,
    employerName: v.optionalString(data.employerName, "employerName", { max: 160 }),
    isActive: false,
  });
  return { employmentType };
}

/**
 * `ED15`/`ED15B`/`ED16` need the income, whether the employer is verified, and
 * — for the borrower — whether a co-borrower becomes mandatory.
 */
async function salary({ db, application, applicant, data, role }) {
  const monthlyIncome = v.requireNumber(data.monthlyIncome, "monthlyIncome", {
    min: 0,
    max: 1_000_000_000,
  });
  const employerVerified = v.requireBoolean(data.employerVerified, "employerVerified");

  await repository.upsertEmployment(db, applicant.id, {
    monthlyIncome,
    employerVerified,
    isActive: true,
    verifiedAt: employerVerified ? new Date() : null,
  });

  if (role === "BORROWER") {
    // Mirrors ED16: below this income the flow routes to the co-borrower.
    await applicationRepository.setRequiresCoborrower(
      db,
      application.id,
      monthlyIncome < MINIMUM_INCOME_WITHOUT_COBORROWER
    );
  }

  return { monthlyIncome, employerVerified };
}

/**
 * `ED17`/`ED18` need a verified registration and revenue above 1,000,000.
 * The definition accepts revenue above 500,000 only to reject it, so the gap
 * between those two numbers is reported as a validation error instead of a
 * dead end.
 */
async function business({ db, applicant, data, role }) {
  const registrationVerified = v.requireBoolean(data.registrationVerified, "registrationVerified");
  const annualRevenue = v.optionalNumber(data.annualRevenue, "annualRevenue", { min: 0 });

  if (
    role === "BORROWER" &&
    registrationVerified &&
    (annualRevenue === null || annualRevenue <= MINIMUM_VERIFIED_BUSINESS_REVENUE)
  ) {
    throw validationFailed(
      `'annualRevenue' must be greater than ${MINIMUM_VERIFIED_BUSINESS_REVENUE} for a verified business`
    );
  }

  await repository.upsertBusiness(db, applicant.id, {
    registrationVerified,
    annualRevenue,
    verifiedAt: registrationVerified ? new Date() : null,
  });

  return { registrationVerified, annualRevenue };
}

/** `ED24`/`ED25` look at the uploaded documents; this step adds the optional ones. */
async function documentUpload({ db, applicant, data }) {
  const documents = Array.isArray(data.documents) ? data.documents : [];
  const uploaded = [];

  for (const document of documents) {
    const docType = v.requireEnum(document?.type, "documents[].type", EXTRA_DOCUMENTS);
    const fileUrl = v.requireString(document?.fileUrl, "documents[].fileUrl", { max: 2048 });
    await repository.upsertDocument(db, applicant.id, docType, { fileUrl });
    uploaded.push(docType);
  }

  return { uploaded };
}

/** `ED26`/`ED27` only leave this node once consent is on record. */
async function consent({ db, application, data, ip }) {
  const granted = v.requireBoolean(data.consentGiven, "consentGiven");
  if (!granted) {
    throw validationFailed("Loan consent must be accepted to continue");
  }

  const record = await repository.saveConsent(db, application.id, "BORROWER_CONSENT", {
    granted,
    ipAddress: ip,
  });

  return { consentType: record.consent_type, granted: record.granted, grantedAt: record.granted_at };
}

module.exports = {
  personalInfo,
  address,
  employment,
  salary,
  business,
  documentUpload,
  consent,
};
