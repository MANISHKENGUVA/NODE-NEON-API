/**
 * SQL for KYC checks and the applicant's bank account.
 */
const { run } = require("../../db/pool");

async function upsertKycCheck(db, applicantId, checkType, check) {
  const result = await run(
    db,
    `INSERT INTO kyc_checks
       (applicant_id, check_type, status, score, liveness_passed, name_matched, mobile_linked,
        blacklisted, provider, reference)
     VALUES ($1, $2, COALESCE($3, 'PENDING'), $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (applicant_id, check_type) DO UPDATE
        SET status          = COALESCE(EXCLUDED.status, kyc_checks.status),
            score           = COALESCE(EXCLUDED.score, kyc_checks.score),
            liveness_passed = COALESCE(EXCLUDED.liveness_passed, kyc_checks.liveness_passed),
            name_matched    = COALESCE(EXCLUDED.name_matched, kyc_checks.name_matched),
            mobile_linked   = COALESCE(EXCLUDED.mobile_linked, kyc_checks.mobile_linked),
            blacklisted     = COALESCE(EXCLUDED.blacklisted, kyc_checks.blacklisted),
            provider        = COALESCE(EXCLUDED.provider, kyc_checks.provider),
            reference       = COALESCE(EXCLUDED.reference, kyc_checks.reference),
            updated_at      = now()
     RETURNING *`,
    [
      applicantId,
      checkType,
      check.status ?? null,
      check.score ?? null,
      check.livenessPassed ?? null,
      check.nameMatched ?? null,
      check.mobileLinked ?? null,
      check.blacklisted ?? null,
      check.provider ?? null,
      check.reference ?? null,
    ]
  );
  return result.rows[0];
}

async function upsertBankAccount(db, applicantId, account) {
  const result = await run(
    db,
    `INSERT INTO bank_accounts
       (applicant_id, account_number_masked, account_number_valid, ifsc, ifsc_valid, holder_name,
        bank_name, branch, verification_status, verified_at, statement_uploaded, statement_valid,
        statement_file_url)
     VALUES ($1, $2, COALESCE($3, false), $4, COALESCE($5, false), $6, $7, $8,
             COALESCE($9, 'PENDING'), $10, COALESCE($11, false), COALESCE($12, false), $13)
     ON CONFLICT (applicant_id) DO UPDATE
        SET account_number_masked = COALESCE(EXCLUDED.account_number_masked, bank_accounts.account_number_masked),
            account_number_valid  = COALESCE($3, bank_accounts.account_number_valid),
            ifsc                  = COALESCE(EXCLUDED.ifsc, bank_accounts.ifsc),
            ifsc_valid            = COALESCE($5, bank_accounts.ifsc_valid),
            holder_name           = COALESCE(EXCLUDED.holder_name, bank_accounts.holder_name),
            bank_name             = COALESCE(EXCLUDED.bank_name, bank_accounts.bank_name),
            branch                = COALESCE(EXCLUDED.branch, bank_accounts.branch),
            verification_status   = COALESCE($9, bank_accounts.verification_status),
            verified_at           = COALESCE($10, bank_accounts.verified_at),
            statement_uploaded    = COALESCE($11, bank_accounts.statement_uploaded),
            statement_valid       = COALESCE($12, bank_accounts.statement_valid),
            statement_file_url    = COALESCE(EXCLUDED.statement_file_url, bank_accounts.statement_file_url),
            updated_at            = now()
     RETURNING *`,
    [
      applicantId,
      account.accountNumberMasked ?? null,
      account.accountNumberValid ?? null,
      account.ifsc ?? null,
      account.ifscValid ?? null,
      account.holderName ?? null,
      account.bankName ?? null,
      account.branch ?? null,
      account.verificationStatus ?? null,
      account.verifiedAt ?? null,
      account.statementUploaded ?? null,
      account.statementValid ?? null,
      account.statementFileUrl ?? null,
    ]
  );
  return result.rows[0];
}

module.exports = { upsertKycCheck, upsertBankAccount };
