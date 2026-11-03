/**
 * Application lifecycle: create, list, read.
 *
 * Creation is the only public write that does not need a session: it mints the
 * application, the borrower's row and the borrower's session in one
 * transaction. Everything after that is step submission.
 */
const { withTransaction, getPool, run } = require("../../db/pool");
const { rethrowDbError } = require("../../core/dbErrors");
const { conflict, notFound } = require("../../core/errors");
const { newApplicationNumber, newWorkflowId } = require("../../core/ids");
const { sha256 } = require("../../core/hash");
const { definitionVersion, startState, getActorForNode } = require("../../workflow/definition");
const applicationRepository = require("./applicationRepository");
const sessionService = require("../session/sessionService");
const sessionRepository = require("../session/sessionRepository");
const captcha = require("../captcha/captchaService");

function personView(applicant) {
  if (!applicant) return null;
  return {
    id: applicant.id,
    fullName: applicant.full_name,
    dateOfBirth: applicant.date_of_birth,
    gender: applicant.gender,
    maritalStatus: applicant.marital_status,
    email: applicant.email,
    mobileNumber: applicant.mobile_number,
    // Only the last four digits of a national id are ever stored in clear.
    panLast4: applicant.pan_last4,
    aadhaarLast4: applicant.aadhaar_last4,
    loanPurpose: applicant.loan_purpose,
  };
}

function addressView(address) {
  if (!address) return null;
  return {
    line1: [address.flat_no, address.building].filter(Boolean).join(", ") || null,
    street: address.street,
    landmark: address.landmark,
    city: address.city,
    district: address.district,
    state: address.state,
    pincode: address.pincode,
    country: address.country,
    residenceType: address.residence_type,
    isValid: address.is_valid,
    pincodeVerified: address.pincode_verified,
  };
}

function employmentView(employment) {
  if (!employment) return null;
  return {
    employmentType: employment.employment_type,
    employerName: employment.employer_name,
    designation: employment.designation,
    isActive: employment.is_active,
    monthlyIncome:
      employment.monthly_income === null ? null : Number(employment.monthly_income),
    employerVerified: employment.employer_verified,
  };
}

function businessView(business) {
  if (!business) return null;
  return {
    registrationExists: business.registration_exists,
    registrationVerified: business.registration_verified,
    registrationNumber: business.registration_number,
    annualRevenue: business.annual_revenue === null ? null : Number(business.annual_revenue),
  };
}

function bankView(bank) {
  if (!bank) return null;
  return {
    accountNumber: bank.account_number_masked,
    ifsc: bank.ifsc,
    holderName: bank.holder_name,
    bankName: bank.bank_name,
    branch: bank.branch,
    verificationStatus: bank.verification_status,
    statementUploaded: bank.statement_uploaded,
    statementValid: bank.statement_valid,
  };
}

function kycView(checks) {
  return {
    pan: checks.PAN ? { status: checks.PAN.status, nameMatched: checks.PAN.name_matched } : null,
    aadhaar: checks.AADHAAR
      ? { status: checks.AADHAAR.status, mobileLinked: checks.AADHAAR.mobile_linked }
      : null,
    face: checks.FACE
      ? {
          status: checks.FACE.status,
          score: checks.FACE.score === null ? null : Number(checks.FACE.score),
          livenessPassed: checks.FACE.liveness_passed,
        }
      : null,
  };
}

function documentsView(documents) {
  return Object.entries(documents).map(([docType, row]) => ({
    docType,
    fileUrl: row.file_url,
    isValid: row.is_valid,
    uploadedAt: row.uploaded_at,
  }));
}

function creditView(credit) {
  if (!credit) return null;
  return {
    creditScore: credit.credit_score,
    consentGiven: credit.consent_given,
    riskScore: credit.risk_score,
    fraudStatus: credit.fraud_status,
    eligibilityStatus: credit.eligibility_status,
    documentVerificationStatus: credit.document_verification_status,
    assessedAt: credit.assessed_at,
  };
}

function offerView(offer) {
  if (!offer) return null;
  return {
    interestRate: offer.interest_rate === null ? null : Number(offer.interest_rate),
    interestRateCalculated: offer.interest_rate_calculated,
    borrowerAccepted: offer.borrower_accepted,
    agreementGenerated: offer.agreement_generated,
    esignStatus: offer.esign_status,
    mandateStatus: offer.mandate_status,
  };
}

function disbursementView(disbursement) {
  if (!disbursement) return null;
  return {
    status: disbursement.status,
    requestStatus: disbursement.request_status,
    amount: disbursement.amount === null ? null : Number(disbursement.amount),
    providerReference: disbursement.provider_reference,
    failureReason: disbursement.failure_reason,
    createdAt: disbursement.created_at,
  };
}

function decisionsView(decisions) {
  return Object.entries(decisions).map(([decisionType, row]) => ({
    decisionType,
    decision: row.decision,
    remarks: row.remarks,
    decidedByRole: row.decided_by_role,
    decidedAt: row.decided_at,
  }));
}

/** Creates once per caller-supplied idempotency key and replays the same result. */
async function create({ captchaToken, ip, idempotencyKey }) {
  const keyHash = sha256(`application-create:${idempotencyKey}`);
  const requestFingerprint = sha256("loan-application:create:v1");
  const db = getPool();

  try {
    return await withTransaction(async (db) => {
      await run(db, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [keyHash]);

      const previous = await applicationRepository.findCreationRequest(db, keyHash);
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint) {
          throw conflict(
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was already used for a different request"
          );
        }

        const application = await applicationRepository.findById(db, previous.application_id);
        if (!application) {
          throw conflict("IDEMPOTENCY_RESULT_UNAVAILABLE", "The original application is unavailable");
        }

        const storedSession = previous.session_id
          ? await sessionRepository.findById(db, previous.session_id)
          : null;
        const sessionIsLive =
          storedSession &&
          storedSession.application_id === application.id &&
          !storedSession.revoked_at &&
          new Date(storedSession.expires_at).getTime() > Date.now();
        const session = sessionIsLive
          ? await sessionService.resolveToken(db, storedSession.session_id)
          : await sessionService.issue(db, {
              applicationId: application.id,
              actor: "BORROWER",
              application,
            });

        if (!sessionIsLive) {
          await applicationRepository.updateCreationRequestSession(
            db,
            keyHash,
            session.sessionId
          );
        }

        return { application, session, created: false };
      }

      await captcha.verify({ token: captchaToken, remoteIp: ip, required: true });

      const application = await applicationRepository.createApplication(db, {
        applicationNo: newApplicationNumber(),
        workflowId: newWorkflowId(),
        definitionVersion,
        startNode: startState,
        actor: getActorForNode(startState),
      });

      const session = await sessionService.issue(db, {
        applicationId: application.id,
        actor: "BORROWER",
        application,
      });

      await applicationRepository.createCreationRequest(db, {
        keyHash,
        requestFingerprint,
        applicationId: application.id,
        sessionId: session.sessionId,
      });

      return { application, session, created: true };
    });
  } catch (error) {
    rethrowDbError(error);
  }
}

/** Paginated list for the admin surface. */
async function list({ limit = 20, offset = 0, status = null }) {
  const db = getPool();
  const { rows, total } = await applicationRepository.listApplications(db, {
    limit,
    offset,
    status,
  });

  return {
    total,
    limit,
    offset,
    applications: rows.map((row) => ({
      id: row.id,
      applicationNo: row.application_no,
      workflowId: row.workflow_id,
      status: row.status,
      currentNode: row.current_node,
      currentActor: row.current_actor,
      requestedAmount: row.requested_amount === null ? null : Number(row.requested_amount),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    })),
  };
}

/**
 * Full read model for one application.
 *
 * Every value here is either an enum, a status or masked data — no PAN, no
 * Aadhaar and no full account number leaves the database.
 */
async function detail(applicationId) {
  const db = getPool();
  const application = await applicationRepository.findById(db, applicationId);
  if (!application) throw notFound("Application not found");

  const dataset = await applicationRepository.loadWorkflowDataset(db, application);

  return {
    id: application.id,
    applicationNo: application.application_no,
    workflowId: application.workflow_id,
    definitionVersion: application.definition_version,
    status: application.status,
    currentNode: application.current_node,
    currentActor: application.current_actor,
    requiresCoborrower: application.requires_coborrower,
    requestedAmount:
      application.requested_amount === null ? null : Number(application.requested_amount),
    createdAt: application.created_at,
    updatedAt: application.updated_at,
    completedAt: application.completed_at,
    borrower: dataset.borrower
      ? {
          ...personView(dataset.borrower),
          address: addressView(dataset.borrowerAddress),
          employment: employmentView(dataset.borrowerEmployment),
          business: businessView(dataset.borrowerBusiness),
          bank: bankView(dataset.borrowerBank),
          kyc: kycView(dataset.borrowerKyc),
          documents: documentsView(dataset.borrowerDocuments),
        }
      : null,
    coborrower: dataset.coborrower
      ? {
          ...personView(dataset.coborrower),
          address: addressView(dataset.coborrowerAddress),
          employment: employmentView(dataset.coborrowerEmployment),
          business: businessView(dataset.coborrowerBusiness),
          bank: bankView(dataset.coborrowerBank),
          kyc: kycView(dataset.coborrowerKyc),
          documents: documentsView(dataset.coborrowerDocuments),
        }
      : null,
    consents: Object.entries(dataset.consents).map(([consentType, row]) => ({
      consentType,
      granted: row.granted,
      grantedAt: row.granted_at,
    })),
    credit: creditView(dataset.credit),
    offer: offerView(dataset.offer),
    disbursement: disbursementView(dataset.disbursement),
    decisions: decisionsView(dataset.decisions),
  };
}

module.exports = { create, list, detail, personView };
