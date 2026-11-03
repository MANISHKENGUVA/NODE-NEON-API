/**
 * KYC steps the applicant completes themselves.
 *
 * The heavy checks (face match, PAN lookup, bank penny-drop) are system nodes
 * that only an internal service may complete — see `systemSteps.js`. Here we
 * only handle the upload and the node whose access block asks for an
 * authenticated Aadhaar session.
 */
const v = require("../../core/validation");
const { forbidden } = require("../../core/errors");
const kycRepository = require("../kyc/kycRepository");
const applicantRepository = require("../applicant/applicantRepository");
const authRepository = require("../auth/authRepository");

/** `ED03`/`ED04` need both identity documents present. */
async function kycUpload({ db, applicant, data }) {
  const aadhaarFileUrl = v.requireString(data.aadhaarFileUrl, "aadhaarFileUrl", { max: 2048 });
  const panFileUrl = v.requireString(data.panFileUrl, "panFileUrl", { max: 2048 });

  await applicantRepository.upsertDocument(db, applicant.id, "AADHAAR", {
    fileUrl: aadhaarFileUrl,
  });
  await applicantRepository.upsertDocument(db, applicant.id, "PAN", { fileUrl: panFileUrl });

  return { uploaded: ["AADHAAR", "PAN"] };
}

/**
 * `ED10`/`ED11` need a verified Aadhaar whose mobile is linked.
 *
 * Successful Aadhaar OTP authentication *is* that proof: the code is delivered
 * to the Aadhaar-linked mobile, so a verified challenge means the link exists.
 * The access block on this node declares `authentication.methods = ["AADHAAR"]`,
 * and this handler refuses to run without it.
 */
async function aadhaarVerification({ db, applicant, session }) {
  const authentication = await authRepository.findActiveAuthentication(
    db,
    session.sessionId,
    "AADHAAR"
  );

  if (!authentication) {
    throw forbidden("Authenticate with Aadhaar before completing this step");
  }

  const check = await kycRepository.upsertKycCheck(db, applicant.id, "AADHAAR", {
    status: "VERIFIED",
    mobileLinked: true,
    provider: "AADHAAR_AUTH",
    reference: authentication.auth_id,
  });

  return { status: check.status, mobileLinked: check.mobile_linked };
}

module.exports = { kycUpload, aadhaarVerification };
