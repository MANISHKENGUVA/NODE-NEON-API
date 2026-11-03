/**
 * SQL for the lender / manager side: credit assessment, offer, agreement,
 * mandate status and disbursement attempts.
 */
const { run } = require("../../db/pool");

async function upsertCreditAssessment(db, applicationId, assessment) {
  const result = await run(
    db,
    `INSERT INTO credit_assessments
       (application_id, credit_score, consent_given, risk_score, fraud_status,
        eligibility_status, document_verification_status)
     VALUES ($1, $2, COALESCE($3, false), $4, COALESCE($5, 'PENDING'),
             COALESCE($6, 'PENDING'), COALESCE($7, 'PENDING'))
     ON CONFLICT (application_id) DO UPDATE
        SET credit_score                 = COALESCE($2, credit_assessments.credit_score),
            consent_given                = COALESCE($3, credit_assessments.consent_given),
            risk_score                   = COALESCE($4, credit_assessments.risk_score),
            fraud_status                 = COALESCE($5, credit_assessments.fraud_status),
            eligibility_status           = COALESCE($6, credit_assessments.eligibility_status),
            document_verification_status = COALESCE($7, credit_assessments.document_verification_status),
            assessed_at                  = now()
     RETURNING *`,
    [
      applicationId,
      assessment.creditScore ?? null,
      assessment.consentGiven ?? null,
      assessment.riskScore ?? null,
      assessment.fraudStatus ?? null,
      assessment.eligibilityStatus ?? null,
      assessment.documentVerificationStatus ?? null,
    ]
  );
  return result.rows[0];
}

/** Current assessment row, or null when the bureau was never called. */
function findCreditAssessment(db, applicationId) {
  return run(db, "SELECT * FROM credit_assessments WHERE application_id = $1", [
    applicationId,
  ]).then((result) => result.rows[0] ?? null);
}

async function upsertOffer(db, applicationId, offer) {
  const result = await run(
    db,
    `INSERT INTO loan_offers
       (application_id, interest_rate, interest_rate_calculated, borrower_accepted, accepted_at,
        agreement_generated, agreement_generated_at, esign_status, mandate_status)
     VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), $5,
             COALESCE($6, false), $7, COALESCE($8, 'PENDING'), COALESCE($9, 'PENDING'))
     ON CONFLICT (application_id) DO UPDATE
        SET interest_rate            = COALESCE($2, loan_offers.interest_rate),
            interest_rate_calculated = COALESCE($3, loan_offers.interest_rate_calculated),
            borrower_accepted        = COALESCE($4, loan_offers.borrower_accepted),
            accepted_at              = COALESCE($5, loan_offers.accepted_at),
            agreement_generated      = COALESCE($6, loan_offers.agreement_generated),
            agreement_generated_at   = COALESCE($7, loan_offers.agreement_generated_at),
            esign_status             = COALESCE($8, loan_offers.esign_status),
            mandate_status           = COALESCE($9, loan_offers.mandate_status),
            updated_at               = now()
     RETURNING *`,
    [
      applicationId,
      offer.interestRate ?? null,
      offer.interestRateCalculated ?? null,
      offer.borrowerAccepted ?? null,
      offer.acceptedAt ?? null,
      offer.agreementGenerated ?? null,
      offer.agreementGeneratedAt ?? null,
      offer.esignStatus ?? null,
      offer.mandateStatus ?? null,
    ]
  );
  return result.rows[0];
}

async function insertDisbursement(db, applicationId, attempt) {
  const result = await run(
    db,
    `INSERT INTO disbursements
       (application_id, status, request_status, retry_allowed, amount, provider_reference, failure_reason)
     VALUES ($1, $2, COALESCE($3, 'PENDING'), COALESCE($4, false), $5, $6, $7)
     RETURNING *`,
    [
      applicationId,
      attempt.status,
      attempt.requestStatus ?? null,
      attempt.retryAllowed ?? null,
      attempt.amount ?? null,
      attempt.providerReference ?? null,
      attempt.failureReason ?? null,
    ]
  );
  return result.rows[0];
}

/** Latest attempt for an application, or null when none was made yet. */
function findLatestDisbursement(db, applicationId) {
  return run(
    db,
    `SELECT * FROM disbursements
      WHERE application_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [applicationId]
  ).then((result) => result.rows[0] ?? null);
}

/** Patches the latest attempt in place (retry flag, provider outcome). */
async function updateLatestDisbursement(db, applicationId, patch) {
  const result = await run(
    db,
    `UPDATE disbursements
        SET retry_allowed      = COALESCE($2, retry_allowed),
            status             = COALESCE($3, status),
            request_status     = COALESCE($4, request_status),
            provider_reference = COALESCE($5, provider_reference),
            failure_reason     = COALESCE($6, failure_reason),
            updated_at         = now()
      WHERE id = (SELECT id FROM disbursements
                   WHERE application_id = $1
                   ORDER BY created_at DESC, id DESC
                   LIMIT 1)
      RETURNING *`,
    [
      applicationId,
      patch.retryAllowed ?? null,
      patch.status ?? null,
      patch.requestStatus ?? null,
      patch.providerReference ?? null,
      patch.failureReason ?? null,
    ]
  );
  return result.rows[0] ?? null;
}

async function insertDecision(db, applicationId, decision) {
  const result = await run(
    db,
    `INSERT INTO underwriting_decisions
       (application_id, decision_type, decision, remarks, decided_by_role, decided_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      applicationId,
      decision.decisionType,
      decision.decision,
      decision.remarks ?? null,
      decision.decidedByRole,
      decision.decidedBy ?? null,
    ]
  );
  return result.rows[0];
}

module.exports = {
  upsertCreditAssessment,
  findCreditAssessment,
  upsertOffer,
  insertDisbursement,
  findLatestDisbursement,
  updateLatestDisbursement,
  insertDecision,
};
