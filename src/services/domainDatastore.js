const { sql } = require("../config/db");

// ─────────────────────────────────────────────────────────────────────────────
// Table DDL
// ONE row per workflow_id. All domains are nested keys inside the data JSONB.
// data shape: { PERSONALDETAILS: {...}, APPLICATION: {...}, ADDRESS: {...}, ... }
// ─────────────────────────────────────────────────────────────────────────────
async function createDomainDatastoreTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS domain_datastore (
      uuid        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id VARCHAR(255) NOT NULL UNIQUE,
      data        JSONB        NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ  DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `;
  return { success: true, message: "Table domain_datastore created/verified successfully" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core upsert — merges { [domain]: domainData } into the single row for workflowId
// Uses jsonb_build_object so the merge is deep at the domain key level.
// ─────────────────────────────────────────────────────────────────────────────
async function upsertDomainData({ workflowId, domain, data }) {
  console.log(`[domainDatastore] Upserting domain=${domain} into workflowId=${workflowId}`);

  const domainPatch = JSON.stringify({ [domain]: data });

  const [record] = await sql`
    INSERT INTO domain_datastore (workflow_id, data)
    VALUES (${workflowId}, ${domainPatch}::jsonb)
    ON CONFLICT (workflow_id)
    DO UPDATE SET
      data       = domain_datastore.data || ${domainPatch}::jsonb,
      updated_at = NOW()
    RETURNING *
  `;

  console.log(`[domainDatastore] Upserted row for workflowId=${workflowId}:`, JSON.stringify(record, null, 2));
  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic function registry
// Pattern: callDynamic_eventype_db_storage_{EVENTTYPE}(workflowId, formData)
//
// Each handler writes its domain data + updates APPLICATION.currentStep
// — all merged into the SINGLE row for this workflowId.
// ─────────────────────────────────────────────────────────────────────────────

async function callDynamic_eventype_db_storage_PERSONAL_INFO_SUBMITTED(workflowId, formData) {
  // Merge PERSONALDETAILS and APPLICATION into the single workflow row
  const patch = {
    PERSONALDETAILS: {
      fullName:        formData.fullName,
      fathersName:     formData.fathersName,
      mothersName:     formData.mothersName,
      dateOfBirth:     formData.dateOfBirth,
      gender:          formData.gender,
      maritalStatus:   formData.maritalStatus,
      email:           formData.email,
      mobileNumber:    formData.mobileNumber,
      aadhaarNumber:   formData.aadhaarNumber,
      panNumber:       formData.panNumber,
      loanPurpose:     formData.loanPurpose,
      // computed flags — used by ruleEngine
      basicInfoCompleted: true,
      financialStatus: {
        employmentType:      formData.employmentType,
        monthlyIncome:       formData.monthlyIncome,
        blacklistedEmployer: false,
      },
    },
    APPLICATION: {
      currentStep: "PERSONAL_INFO_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_ADDRESS_INFO_SUBMITTED(workflowId, formData) {
  const patch = {
    ADDRESS: {
      current: {
        flatNo:                        formData.flatNo,
        building:                      formData.building,
        street:                        formData.street,
        landmark:                      formData.landmark,
        city:                          formData.city,
        district:                      formData.district,
        state:                         formData.state,
        pincode:                       formData.pincode,
        country:                       formData.country || "INDIA",
        residenceType:                 formData.residenceType,
        permanentAddressSameAsCurrent: formData.permanentAddressSameAsCurrent ?? false,
        // computed flags
        isValid:         true,
        pincodeVerified: true,
      },
    },
    APPLICATION: {
      currentStep: "ADDRESS_INFO_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_KYC_UPLOAD_SUBMITTED(workflowId, formData) {
  const patch = {
    DOCUMENTS: {
      identity: {
        aadharUploaded: formData.aadharUploaded ?? true,
        panUploaded:    formData.panUploaded    ?? true,
        aadharUrl:      formData.aadharUrl,
        panUrl:         formData.panUrl,
      },
    },
    APPLICATION: {
      currentStep: "KYC_UPLOAD_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_EMPLOYMENT_INFO_SUBMITTED(workflowId, formData) {
  const patch = {
    EMPLOYMENT: {
      employmentType: formData.employmentType,
      currentCompany: {
        name:         formData.companyName,
        designation:  formData.designation,
        workingSince: formData.workingSince,
        isActive:     formData.isActive ?? true,
      },
    },
    APPLICATION: {
      currentStep: "EMPLOYMENT_INFO_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_SALARY_INFO_SUBMITTED(workflowId, formData) {
  const patch = {
    EMPLOYMENT: {
      salary: {
        monthlyIncome:   Number(formData.monthlyIncome),
        companyVerified: formData.companyVerified ?? true,
      },
    },
    APPLICATION: {
      currentStep: "SALARY_INFO_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_BUSINESS_INFO_SUBMITTED(workflowId, formData) {
  const patch = {
    BUSINESS: {
      registration: {
        exists:      formData.registrationExists   ?? true,
        isVerified:  formData.registrationVerified ?? true,
        regNumber:   formData.regNumber,
      },
      financials: {
        annualRevenue: Number(formData.annualRevenue),
      },
    },
    APPLICATION: {
      currentStep: "BUSINESS_INFO_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_FACE_VERIFICATION_SUBMITTED(workflowId, formData) {
  // Both matchScore and livenessPassed are null — verification result not yet determined
  const patch = {
    KYC: {
      faceVerification: {
        matchScore:     null,
        livenessPassed: null,
        status:         "PENDING",
      },
    },
    APPLICATION: {
      currentStep: "FACE_VERIFICATION_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_FACE_VERIFICATION_RESULT_SUBMITTED(workflowId, formData) {
  // Called when the face verification engine returns actual results
  const matchScore    = Number(formData.matchScore);
  const livenessPassed = formData.livenessPassed === true || formData.livenessPassed === "true";
  const passed         = matchScore >= 80 && livenessPassed;

  const patch = {
    KYC: {
      faceVerification: {
        matchScore,
        livenessPassed,
        status: passed ? "VERIFIED" : "FAILED",
      },
    },
    APPLICATION: {
      currentStep: "FACE_VERIFICATION_RESULT_RECEIVED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_PAN_VERIFICATION_SUBMITTED(workflowId, formData) {
  const isVerified = formData.status === "VERIFIED" || formData.status === undefined || formData.status === true;
  const patch = {
    KYC: {
      pan: {
        status:      isVerified ? "VERIFIED" : (formData.status || "FAILED"),
        nameMatched: formData.nameMatched !== false,
        blacklisted: formData.blacklisted === true,
        panNumber:   formData.panNumber || null,
      },
    },
    APPLICATION: {
      currentStep: "PAN_VERIFICATION_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_AADHAR_VERIFICATION_SUBMITTED(workflowId, formData) {
  const isVerified = formData.status === "VERIFIED" || formData.status === undefined || formData.status === true;
  const patch = {
    KYC: {
      aadhar: {
        status:       isVerified ? "VERIFIED" : (formData.status || "FAILED"),
        mobileLinked: formData.mobileLinked !== false,
        aadharNumber: formData.aadharNumber || null,
      },
    },
    APPLICATION: {
      currentStep: "AADHAR_VERIFICATION_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_BANK_DETAILS_SUBMITTED(workflowId, formData) {
  const patch = {
    BANK: {
      accountNumber: {
        number: formData.accountNumber || formData.account_number || null,
        valid:  formData.accountNumberValid !== false,
      },
      ifsc: {
        code:  formData.ifsc || formData.ifscCode || null,
        valid: formData.ifscValid !== false,
      },
      accountHolderName: formData.accountHolderName || null,
      bankName:          formData.bankName || null,
      branch:            formData.branch || null,
    },
    APPLICATION: {
      currentStep: "BANK_DETAILS_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_BANK_ACCOUNT_VERIFICATION_SUBMITTED(workflowId, formData) {
  const isVerified = formData.status === "VERIFIED" || formData.status === undefined || formData.status === true;
  const patch = {
    BANK: {
      verification: {
        status:     isVerified ? "VERIFIED" : (formData.status || "FAILED"),
        verifiedAt: new Date().toISOString(),
      },
    },
    APPLICATION: {
      currentStep: "BANK_ACCOUNT_VERIFICATION_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_BANK_STATEMENT_UPLOAD_SUBMITTED(workflowId, formData) {
  const patch = {
    DOCUMENTS: {
      bankStatement: {
        uploaded: formData.uploaded !== false,
        valid:    formData.valid !== false,
        fileUrl:  formData.fileUrl || null,
      },
    },
    APPLICATION: {
      currentStep: "BANK_STATEMENT_UPLOAD_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED(workflowId, formData) {
  const patch = {
    DOCUMENTS: {
      requiredDocuments: {
        completed: formData.completed !== false,
        invalid:   formData.invalid === true,
      },
    },
    APPLICATION: {
      currentStep: "DOCUMENT_UPLOAD_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_LOAN_CONSENT_SUBMITTED(workflowId, formData) {
  const requiresCoborrower = formData.requiresCoborrower === true || formData.requiresCoborrower === "true";
  const patch = {
    CONSENT: {
      borrowerConsent: formData.borrowerConsent !== false,
      consentedAt:     new Date().toISOString(),
    },
    APPLICATION: {
      currentStep:        "LOAN_CONSENT_COMPLETED",
      requiresCoborrower: requiresCoborrower,
    },
  };
  return upsertAllDomains(workflowId, patch);
}


async function callDynamic_eventype_db_storage_FRAUD_CHECK_SUBMITTED(workflowId, formData) {
  const patch = {
    FRAUDCHECK: {
      status:     formData.status,
      checkedAt:  new Date().toISOString(),
      remarks:    formData.remarks || null,
    },
    APPLICATION: {
      currentStep: "FRAUD_CHECK_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_CREDIT_EXCEPTION_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      creditException: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_CREDIT_EXCEPTION_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_FRAUD_REVIEW_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      fraudReview: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_FRAUD_REVIEW_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_DOCUMENT_REVIEW_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      documentReview: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_DOCUMENT_REVIEW_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_RISK_REVIEW_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      riskReview: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_RISK_REVIEW_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_ELIGIBILITY_REVIEW_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      eligibilityReview: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_ELIGIBILITY_REVIEW_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_FINAL_APPROVAL_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      finalApproval: {
        decision:   formData.decision,
        approvedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_FINAL_APPROVAL_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_DISBURSEMENT_REVIEW_SUBMITTED(workflowId, formData) {
  const patch = {
    MANAGER: {
      disbursementReview: {
        decision:   formData.decision,
        reviewedAt: new Date().toISOString(),
        remarks:    formData.remarks || null,
      },
    },
    APPLICATION: {
      currentStep: "MANAGER_DISBURSEMENT_REVIEW_COMPLETED",
    },
  };
  return upsertAllDomains(workflowId, patch);
}

async function callDynamic_eventype_db_storage_MANAGER_APPROVAL_SUBMITTED(workflowId, formData) {
  const patch = {
    APPROVAL: {
      managerDecision: formData.approvalDecision || formData.approvalStatus,
      approvedAt:      new Date().toISOString(),
    },
    APPLICATION: {
      currentStep: "MANAGER_APPROVAL_COMPLETED",
    },
  };

  return upsertAllDomains(workflowId, patch);
}

function deepMerge(target, source) {
  if (!target || typeof target !== "object") return source;
  if (!source || typeof source !== "object") return target;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// patch shape: { PERSONALDETAILS: {...}, APPLICATION: {...} }
// ─────────────────────────────────────────────────────────────────────────────
async function upsertAllDomains(workflowId, patch) {
  console.log(`[domainDatastore] upsertAllDomains workflowId=${workflowId} domains=${Object.keys(patch).join(', ')}`);

  // Fetch current stored data to perform deep merge (prevents nested keys like KYC.pan being wiped by KYC.aadhar)
  const existingRows = await sql`
    SELECT data FROM domain_datastore WHERE workflow_id = ${workflowId} LIMIT 1
  `;
  const existingData = existingRows[0]?.data || {};
  const mergedData = deepMerge(existingData, patch);
  const dataStr = JSON.stringify(mergedData);

  const [record] = await sql`
    INSERT INTO domain_datastore (workflow_id, data)
    VALUES (${workflowId}, ${dataStr}::jsonb)
    ON CONFLICT (workflow_id)
    DO UPDATE SET
      data       = ${dataStr}::jsonb,
      updated_at = NOW()
    RETURNING *
  `;

  console.log(`[domainDatastore] Row after upsert:`, JSON.stringify(record, null, 2));
  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────
const EVENTYPE_HANDLER_MAP = {
  PERSONAL_INFO_SUBMITTED:         callDynamic_eventype_db_storage_PERSONAL_INFO_SUBMITTED,
  ADDRESS_INFO_SUBMITTED:          callDynamic_eventype_db_storage_ADDRESS_INFO_SUBMITTED,
  KYC_UPLOAD_SUBMITTED:            callDynamic_eventype_db_storage_KYC_UPLOAD_SUBMITTED,
  FACE_VERIFICATION_SUBMITTED:        callDynamic_eventype_db_storage_FACE_VERIFICATION_SUBMITTED,
  FACE_VERIFICATION_RESULT_SUBMITTED:  callDynamic_eventype_db_storage_FACE_VERIFICATION_RESULT_SUBMITTED,
  PAN_VERIFICATION_SUBMITTED:          callDynamic_eventype_db_storage_PAN_VERIFICATION_SUBMITTED,
  AADHAR_VERIFICATION_SUBMITTED:       callDynamic_eventype_db_storage_AADHAR_VERIFICATION_SUBMITTED,
  BANK_DETAILS_SUBMITTED:              callDynamic_eventype_db_storage_BANK_DETAILS_SUBMITTED,
  BANK_ACCOUNT_VERIFICATION_SUBMITTED: callDynamic_eventype_db_storage_BANK_ACCOUNT_VERIFICATION_SUBMITTED,
  BANK_ACCOUNT_VERIFIED:               callDynamic_eventype_db_storage_BANK_ACCOUNT_VERIFICATION_SUBMITTED,
  BANK_VERIFICATION_SUBMITTED:         callDynamic_eventype_db_storage_BANK_ACCOUNT_VERIFICATION_SUBMITTED,
  BANK_STATEMENT_UPLOAD_SUBMITTED:     callDynamic_eventype_db_storage_BANK_STATEMENT_UPLOAD_SUBMITTED,
  BANK_STATEMENT_UPLOADED:             callDynamic_eventype_db_storage_BANK_STATEMENT_UPLOAD_SUBMITTED,
  BANK_STATEMENT_SUBMITTED:            callDynamic_eventype_db_storage_BANK_STATEMENT_UPLOAD_SUBMITTED,
  DOCUMENT_UPLOAD_SUBMITTED:           callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED,
  DOCUMENT_UPLOADED:                   callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED,
  DOCUMENTS_UPLOAD_SUBMITTED:          callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED,
  DOCUMENTS_SUBMITTED:                 callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED,
  LOAN_CONSENT_SUBMITTED:              callDynamic_eventype_db_storage_LOAN_CONSENT_SUBMITTED,
  CONSENT_SUBMITTED:                   callDynamic_eventype_db_storage_LOAN_CONSENT_SUBMITTED,
  FRAUD_CHECK_SUBMITTED:           callDynamic_eventype_db_storage_FRAUD_CHECK_SUBMITTED,
  MANAGER_APPROVAL_SUBMITTED:      callDynamic_eventype_db_storage_MANAGER_APPROVAL_SUBMITTED,
  EMPLOYMENT_INFO_SUBMITTED:       callDynamic_eventype_db_storage_EMPLOYMENT_INFO_SUBMITTED,
  SALARY_INFO_SUBMITTED:           callDynamic_eventype_db_storage_SALARY_INFO_SUBMITTED,
  BUSINESS_INFO_SUBMITTED:         callDynamic_eventype_db_storage_BUSINESS_INFO_SUBMITTED,
};

async function dispatchEventTypeStorage(eventType, workflowId, formData) {
  const handler = EVENTYPE_HANDLER_MAP[eventType];

  if (!handler) {
    console.warn(`[domainDatastore] No handler registered for eventType: ${eventType}`);
    return null;
  }

  console.log(`[domainDatastore] Dispatching callDynamic_eventype_db_storage_${eventType}`);
  return handler(workflowId, formData);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context builder — fetches the single row for workflowId and returns data
// The returned object is the full multi-domain context for ruleEngine:
// {
//   APPLICATION:     { currentStep: "PERSONAL_INFO_COMPLETED" },
//   PERSONALDETAILS: { basicInfoCompleted: true, ... },
//   ...
// }
// ─────────────────────────────────────────────────────────────────────────────
async function buildWorkflowContext(workflowId) {
  const rows = await sql`
    SELECT data FROM domain_datastore
    WHERE workflow_id = ${workflowId}
    LIMIT 1
  `;

  if (!rows || rows.length === 0) {
    console.warn(`[domainDatastore] No domain_datastore row found for workflowId=${workflowId}`);
    return {};
  }

  const context = rows[0].data;
  console.log(`[domainDatastore] Built context for workflowId=${workflowId}:`, JSON.stringify(context, null, 2));
  return context;
}

module.exports = {
  createDomainDatastoreTable,
  upsertDomainData,
  upsertAllDomains,
  dispatchEventTypeStorage,
  buildWorkflowContext,
  callDynamic_eventype_db_storage_PERSONAL_INFO_SUBMITTED,
  callDynamic_eventype_db_storage_ADDRESS_INFO_SUBMITTED,
  callDynamic_eventype_db_storage_KYC_UPLOAD_SUBMITTED,
  callDynamic_eventype_db_storage_EMPLOYMENT_INFO_SUBMITTED,
  callDynamic_eventype_db_storage_SALARY_INFO_SUBMITTED,
  callDynamic_eventype_db_storage_BUSINESS_INFO_SUBMITTED,
  callDynamic_eventype_db_storage_FACE_VERIFICATION_RESULT_SUBMITTED,
  callDynamic_eventype_db_storage_PAN_VERIFICATION_SUBMITTED,
  callDynamic_eventype_db_storage_AADHAR_VERIFICATION_SUBMITTED,
  callDynamic_eventype_db_storage_BANK_DETAILS_SUBMITTED,
  callDynamic_eventype_db_storage_BANK_ACCOUNT_VERIFICATION_SUBMITTED,
  callDynamic_eventype_db_storage_BANK_STATEMENT_UPLOAD_SUBMITTED,
  callDynamic_eventype_db_storage_DOCUMENT_UPLOAD_SUBMITTED,
  callDynamic_eventype_db_storage_LOAN_CONSENT_SUBMITTED,
};
