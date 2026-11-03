/**
 * Applicant lifecycle helpers.
 *
 * An application starts with no borrower row; the row is created the moment
 * the borrower submits their first step, and the same happens for the
 * co-borrower when the flow reaches them. `resolveApplicantForRole` keeps the
 * in-memory application row in sync so the engine sees the new id immediately.
 */
const repository = require("./applicantRepository");
const applicationRepository = require("../application/applicationRepository");

const APPLICANT_ROLES = Object.freeze(["BORROWER", "COBORROWER"]);

/**
 * Returns the applicant for `role`, creating it when missing.
 *
 * Mutates `application.borrower_id` / `application.coborrower_id` on purpose:
 * the caller is inside a transaction holding that row.
 */
async function resolveApplicantForRole(db, application, role) {
  if (role === "BORROWER") {
    if (application.borrower_id) return repository.findApplicantById(db, application.borrower_id);

    const applicant = await repository.createEmptyApplicant(db);
    await applicationRepository.setBorrower(db, application.id, applicant.id);
    application.borrower_id = applicant.id;
    return applicant;
  }

  if (role === "COBORROWER") {
    if (application.coborrower_id) {
      return repository.findApplicantById(db, application.coborrower_id);
    }

    const applicant = await repository.createEmptyApplicant(db);
    await applicationRepository.setCoborrower(db, application.id, applicant.id);
    application.coborrower_id = applicant.id;
    return applicant;
  }

  // LENDER and MANAGER act on the application, not on a person.
  return null;
}

module.exports = { APPLICANT_ROLES, resolveApplicantForRole };
