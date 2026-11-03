/**
 * SQL for the people applying: identity, address, employment, business,
 * documents and consents.
 */
const { run } = require("../../db/pool");

function createEmptyApplicant(db) {
  return run(db, "INSERT INTO applicants DEFAULT VALUES RETURNING *").then(
    (result) => result.rows[0]
  );
}

function findApplicantById(db, applicantId) {
  return run(db, "SELECT * FROM applicants WHERE id = $1", [applicantId]).then(
    (result) => result.rows[0] ?? null
  );
}

function markMobileVerified(db, applicantId, mobileNumber) {
  return run(
    db,
    `UPDATE applicants
        SET mobile_verified_at = now(), updated_at = now()
      WHERE id = $1 AND mobile_number = $2
      RETURNING id`,
    [applicantId, mobileNumber]
  ).then((result) => result.rowCount > 0);
}

function updatePersonalDetails(
  db,
  applicantId,
  { fullName, fatherName, motherName, dateOfBirth, gender, maritalStatus, email, mobileNumber, panHash, panLast4, aadhaarHash, aadhaarLast4, loanPurpose }
) {
  return run(
    db,
    `UPDATE applicants
        SET full_name      = COALESCE($2, full_name),
            father_name    = COALESCE($3, father_name),
            mother_name    = COALESCE($4, mother_name),
            date_of_birth  = COALESCE($5, date_of_birth),
            gender         = COALESCE($6, gender),
            marital_status = COALESCE($7, marital_status),
            email          = COALESCE($8, email),
            mobile_number  = COALESCE($9, mobile_number),
            mobile_verified_at = CASE
              WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM mobile_number THEN NULL
              ELSE mobile_verified_at
            END,
            pan_hash       = COALESCE($10, pan_hash),
            pan_last4      = COALESCE($11, pan_last4),
            aadhaar_hash   = COALESCE($12, aadhaar_hash),
            aadhaar_last4  = COALESCE($13, aadhaar_last4),
            loan_purpose   = COALESCE($14, loan_purpose),
            updated_at     = now()
      WHERE id = $1
      RETURNING *`,
    [
      applicantId,
      fullName,
      fatherName,
      motherName,
      dateOfBirth,
      gender,
      maritalStatus,
      email,
      mobileNumber,
      panHash,
      panLast4,
      aadhaarHash,
      aadhaarLast4,
      loanPurpose,
    ]
  ).then((result) => result.rows[0]);
}

async function upsertAddress(db, applicantId, addressType, address) {
  const result = await run(
    db,
    `INSERT INTO addresses
       (applicant_id, address_type, flat_no, building, street, landmark, city, district,
        state, pincode, country, residence_type, is_valid, pincode_verified, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'INDIA'), $12, $13, $14, $15)
     ON CONFLICT (applicant_id, address_type) DO UPDATE
        SET flat_no          = EXCLUDED.flat_no,
            building         = EXCLUDED.building,
            street           = EXCLUDED.street,
            landmark         = EXCLUDED.landmark,
            city             = EXCLUDED.city,
            district         = EXCLUDED.district,
            state            = EXCLUDED.state,
            pincode          = EXCLUDED.pincode,
            country          = EXCLUDED.country,
            residence_type   = EXCLUDED.residence_type,
            is_valid         = EXCLUDED.is_valid,
            pincode_verified = EXCLUDED.pincode_verified,
            verified_at      = EXCLUDED.verified_at,
            updated_at       = now()
     RETURNING *`,
    [
      applicantId,
      addressType,
      address.flatNo,
      address.building,
      address.street,
      address.landmark,
      address.city,
      address.district,
      address.state,
      address.pincode,
      address.country,
      address.residenceType,
      address.isValid,
      address.pincodeVerified,
      address.verifiedAt ?? null,
    ]
  );
  return result.rows[0];
}

async function upsertEmployment(db, applicantId, employment) {
  const result = await run(
    db,
    `INSERT INTO employment_details
       (applicant_id, employment_type, employer_name, designation, working_since, is_active,
        monthly_income, employer_verified, employer_blacklisted, verified_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, false), $7, COALESCE($8, false), COALESCE($9, false), $10)
     ON CONFLICT (applicant_id) DO UPDATE
        SET employment_type    = COALESCE(EXCLUDED.employment_type, employment_details.employment_type),
            employer_name      = COALESCE(EXCLUDED.employer_name, employment_details.employer_name),
            designation        = COALESCE(EXCLUDED.designation, employment_details.designation),
            working_since      = COALESCE(EXCLUDED.working_since, employment_details.working_since),
            is_active          = COALESCE($6, employment_details.is_active),
            monthly_income     = COALESCE(EXCLUDED.monthly_income, employment_details.monthly_income),
            employer_verified  = COALESCE($8, employment_details.employer_verified),
            employer_blacklisted = COALESCE($9, employment_details.employer_blacklisted),
            verified_at        = COALESCE($10, employment_details.verified_at),
            updated_at         = now()
     RETURNING *`,
    [
      applicantId,
      employment.employmentType ?? null,
      employment.employerName ?? null,
      employment.designation ?? null,
      employment.workingSince ?? null,
      employment.isActive ?? null,
      employment.monthlyIncome ?? null,
      employment.employerVerified ?? null,
      employment.employerBlacklisted ?? null,
      employment.verifiedAt ?? null,
    ]
  );
  return result.rows[0];
}

async function upsertBusiness(db, applicantId, business) {
  const result = await run(
    db,
    `INSERT INTO business_details
       (applicant_id, registration_exists, registration_verified, registration_number, annual_revenue, verified_at)
     VALUES ($1, COALESCE($2, false), COALESCE($3, false), $4, $5, $6)
     ON CONFLICT (applicant_id) DO UPDATE
        SET registration_exists   = COALESCE($2, business_details.registration_exists),
            registration_verified = COALESCE($3, business_details.registration_verified),
            registration_number   = COALESCE($4, business_details.registration_number),
            annual_revenue        = COALESCE($5, business_details.annual_revenue),
            verified_at           = COALESCE($6, business_details.verified_at),
            updated_at            = now()
     RETURNING *`,
    [
      applicantId,
      business.registrationExists ?? null,
      business.registrationVerified ?? null,
      business.registrationNumber ?? null,
      business.annualRevenue ?? null,
      business.verifiedAt ?? null,
    ]
  );
  return result.rows[0];
}

async function upsertDocument(db, applicantId, docType, { fileUrl, isValid = null }) {
  const result = await run(
    db,
    `INSERT INTO documents (applicant_id, doc_type, file_url, is_valid)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (applicant_id, doc_type) DO UPDATE
        SET file_url    = COALESCE(EXCLUDED.file_url, documents.file_url),
            is_valid    = COALESCE(EXCLUDED.is_valid, documents.is_valid),
            uploaded_at = now()
     RETURNING *`,
    [applicantId, docType, fileUrl ?? null, isValid]
  );
  return result.rows[0];
}

async function saveConsent(db, applicationId, consentType, { granted, ipAddress }) {
  const result = await run(
    db,
    `INSERT INTO consents (application_id, consent_type, granted, granted_at, ip_address)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, $4)
     ON CONFLICT (application_id, consent_type) DO UPDATE
        SET granted    = EXCLUDED.granted,
            granted_at = CASE WHEN EXCLUDED.granted THEN now() ELSE NULL END,
            ip_address = COALESCE(EXCLUDED.ip_address, consents.ip_address)
     RETURNING *`,
    [applicationId, consentType, granted, ipAddress ?? null]
  );
  return result.rows[0];
}

module.exports = {
  createEmptyApplicant,
  findApplicantById,
  markMobileVerified,
  updatePersonalDetails,
  upsertAddress,
  upsertEmployment,
  upsertBusiness,
  upsertDocument,
  saveConsent,
};
