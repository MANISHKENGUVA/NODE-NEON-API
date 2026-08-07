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
        addressLine1:    formData.addressLine1,
        addressLine2:    formData.addressLine2,
        city:            formData.city,
        state:           formData.state,
        pincode:         formData.pincode,
        country:         formData.country || "INDIA",
        addressType:     formData.addressType,
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

// ─────────────────────────────────────────────────────────────────────────────
// upsertAllDomains — merges a multi-domain patch object into the single row
// patch shape: { PERSONALDETAILS: {...}, APPLICATION: {...} }
// ─────────────────────────────────────────────────────────────────────────────
async function upsertAllDomains(workflowId, patch) {
  console.log(`[domainDatastore] upsertAllDomains workflowId=${workflowId} domains=${Object.keys(patch).join(', ')}`);

  const patchStr = JSON.stringify(patch);

  const [record] = await sql`
    INSERT INTO domain_datastore (workflow_id, data)
    VALUES (${workflowId}, ${patchStr}::jsonb)
    ON CONFLICT (workflow_id)
    DO UPDATE SET
      data       = domain_datastore.data || ${patchStr}::jsonb,
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
  PERSONAL_INFO_SUBMITTED:    callDynamic_eventype_db_storage_PERSONAL_INFO_SUBMITTED,
  ADDRESS_INFO_SUBMITTED:     callDynamic_eventype_db_storage_ADDRESS_INFO_SUBMITTED,
  KYC_UPLOAD_SUBMITTED:       callDynamic_eventype_db_storage_KYC_UPLOAD_SUBMITTED,
  EMPLOYMENT_INFO_SUBMITTED:  callDynamic_eventype_db_storage_EMPLOYMENT_INFO_SUBMITTED,
  SALARY_INFO_SUBMITTED:      callDynamic_eventype_db_storage_SALARY_INFO_SUBMITTED,
  BUSINESS_INFO_SUBMITTED:    callDynamic_eventype_db_storage_BUSINESS_INFO_SUBMITTED,
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
};
