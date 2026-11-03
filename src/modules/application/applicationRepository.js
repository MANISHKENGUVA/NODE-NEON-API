/**
 * SQL for the loan application aggregate, its event history and the dataset
 * used to build the rule-engine context.
 *
 * Every function takes an executor (`pool` or a transaction client) so the
 * same code runs inside and outside a transaction.
 */
const { run } = require("../../db/pool");

async function createApplication(
  db,
  { applicationNo, workflowId, definitionVersion, startNode, actor }
) {
  const result = await run(
    db,
    `INSERT INTO loan_applications
       (application_no, workflow_id, definition_version, current_node, current_actor)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [applicationNo, workflowId, definitionVersion, startNode, actor]
  );
  return result.rows[0];
}

function findCreationRequest(db, keyHash) {
  return run(
    db,
    `SELECT key_hash, request_fingerprint, application_id, session_id
       FROM application_creation_idempotency
      WHERE key_hash = $1`,
    [keyHash]
  ).then((result) => result.rows[0] ?? null);
}

async function createCreationRequest(db, { keyHash, requestFingerprint, applicationId, sessionId }) {
  await run(
    db,
    `INSERT INTO application_creation_idempotency
       (key_hash, request_fingerprint, application_id, session_id)
     VALUES ($1, $2, $3, $4)`,
    [keyHash, requestFingerprint, applicationId, sessionId]
  );
}

async function updateCreationRequestSession(db, keyHash, sessionId) {
  await run(
    db,
    `UPDATE application_creation_idempotency
        SET session_id = $2
      WHERE key_hash = $1`,
    [keyHash, sessionId]
  );
}

function findById(db, applicationId) {
  return run(db, "SELECT * FROM loan_applications WHERE id = $1", [applicationId]).then(
    (result) => result.rows[0] ?? null
  );
}

function findByWorkflowId(db, workflowId) {
  return run(db, "SELECT * FROM loan_applications WHERE workflow_id = $1", [workflowId]).then(
    (result) => result.rows[0] ?? null
  );
}

/** Row lock for read-modify-write inside a transaction. */
function lockById(db, applicationId) {
  return run(db, "SELECT * FROM loan_applications WHERE id = $1 FOR UPDATE", [applicationId]).then(
    (result) => result.rows[0] ?? null
  );
}

async function listApplications(db, { limit, offset, status }) {
  const conditions = [];
  const values = [];

  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit, offset);

  const result = await run(
    db,
    `SELECT id, application_no, workflow_id, status, current_node, current_actor,
            requested_amount, created_at, updated_at, completed_at
       FROM loan_applications
       ${where}
      ORDER BY created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );

  const countValues = status ? [status] : [];
  const countWhere = status ? "WHERE status = $1" : "";
  const total = await run(
    db,
    `SELECT count(*)::int AS total FROM loan_applications ${countWhere}`,
    countValues
  );

  return { rows: result.rows, total: total.rows[0].total };
}

async function updateState(db, applicationId, { currentNode, currentActor, status, completedAt }) {
  const result = await run(
    db,
    `UPDATE loan_applications
        SET current_node  = $2,
            current_actor = $3,
            status        = COALESCE($4, status),
            completed_at  = COALESCE($5, completed_at),
            updated_at    = now()
      WHERE id = $1
      RETURNING *`,
    [applicationId, currentNode, currentActor, status ?? null, completedAt ?? null]
  );
  return result.rows[0];
}

async function setBorrower(db, applicationId, applicantId) {
  await run(db, "UPDATE loan_applications SET borrower_id = $2, updated_at = now() WHERE id = $1", [
    applicationId,
    applicantId,
  ]);
}

async function setCoborrower(db, applicationId, applicantId) {
  await run(db, "UPDATE loan_applications SET coborrower_id = $2, updated_at = now() WHERE id = $1", [
    applicationId,
    applicantId,
  ]);
}

async function setRequiresCoborrower(db, applicationId, requiresCoborrower) {
  await run(
    db,
    "UPDATE loan_applications SET requires_coborrower = $2, updated_at = now() WHERE id = $1",
    [applicationId, requiresCoborrower]
  );
}

async function setRequestedAmount(db, applicationId, { amount, valid }) {
  await run(
    db,
    `UPDATE loan_applications
        SET requested_amount = $2, requested_amount_valid = $3, updated_at = now()
      WHERE id = $1`,
    [applicationId, amount, valid]
  );
}

// ── Event history ───────────────────────────────────────────────────────────

async function nextEventSequence(db, applicationId) {
  const result = await run(
    db,
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM workflow_events WHERE application_id = $1",
    [applicationId]
  );
  return result.rows[0].next;
}

async function appendEvent(
  db,
  {
    applicationId,
    sequence,
    eventType,
    nodeKey,
    actor,
    fromNode,
    toNode,
    edgeId,
    payload,
    clientEventId,
    requestHash,
  }
) {
  const result = await run(
    db,
    `INSERT INTO workflow_events
       (application_id, sequence, event_type, node_key, actor, from_node, to_node, edge_id,
        payload, client_event_id, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      applicationId,
      sequence,
      eventType,
      nodeKey,
      actor,
      fromNode ?? null,
      toNode ?? null,
      edgeId ?? null,
      JSON.stringify(payload ?? {}),
      clientEventId ?? null,
      requestHash ?? null,
    ]
  );
  return result.rows[0];
}

/** A previously accepted client event id, used to make submissions idempotent. */
function findEventByClientId(db, applicationId, clientEventId) {
  return run(
    db,
    `SELECT *
       FROM workflow_events
      WHERE application_id = $1 AND client_event_id = $2
      LIMIT 1`,
    [applicationId, clientEventId]
  ).then((result) => result.rows[0] ?? null);
}

async function listEvents(db, applicationId, limit = 200) {
  const result = await run(
    db,
    `SELECT sequence, event_type, node_key, actor, from_node, to_node, edge_id, occurred_at
       FROM workflow_events
      WHERE application_id = $1
      ORDER BY sequence ASC
      LIMIT $2`,
    [applicationId, limit]
  );
  return result.rows;
}

/** Ordered history in the shape the transition resolver expects. */
async function loadHistory(db, applicationId) {
  const result = await run(
    db,
    `SELECT node_key, actor FROM workflow_events
      WHERE application_id = $1
      ORDER BY sequence ASC`,
    [applicationId]
  );
  return result.rows.map((row) => ({ nodeKey: row.node_key, actor: row.actor }));
}

// ── Context dataset ─────────────────────────────────────────────────────────

function groupByApplicant(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.applicant_id, row);
  return map;
}

function groupDocuments(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.applicant_id)) map.set(row.applicant_id, {});
    map.get(row.applicant_id)[row.doc_type] = row;
  }
  return map;
}

/**
 * One statement for the whole rule-engine dataset.
 *
 * `Promise.all` on a single client runs the queries one after another, and a
 * step submission rebuilds this dataset — so twelve separate queries meant
 * twelve round trips on every form. Each sub-select keeps the "one row per
 * `SELECT *`" shape the mapping below expects; only the transfer is JSON.
 *
 * Two consequences of the JSON hop: `DATE` columns arrive as `YYYY-MM-DD` and
 * `TIMESTAMPTZ` as RFC 3339 with a `+00:00` offset.
 */
const DATASET_SQL = `
  SELECT
    (SELECT coalesce(json_agg(t), '[]') FROM applicants t
      WHERE t.id = ANY($2::uuid[]))               AS applicants,
    (SELECT coalesce(json_agg(t), '[]') FROM addresses t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS addresses,
    (SELECT coalesce(json_agg(t), '[]') FROM employment_details t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS employments,
    (SELECT coalesce(json_agg(t), '[]') FROM business_details t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS businesses,
    (SELECT coalesce(json_agg(t), '[]') FROM kyc_checks t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS kyc_checks,
    (SELECT coalesce(json_agg(t), '[]') FROM bank_accounts t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS bank_accounts,
    (SELECT coalesce(json_agg(t), '[]') FROM documents t
      WHERE t.applicant_id = ANY($2::uuid[]))     AS documents,
    (SELECT coalesce(json_agg(t), '[]') FROM consents t
      WHERE t.application_id = $1)                AS consents,
    (SELECT coalesce(json_agg(t), '[]') FROM credit_assessments t
      WHERE t.application_id = $1)                AS credit,
    (SELECT coalesce(json_agg(t), '[]') FROM loan_offers t
      WHERE t.application_id = $1)                AS offer,
    (SELECT coalesce(json_agg(t), '[]') FROM (
       SELECT * FROM disbursements
        WHERE application_id = $1
        ORDER BY created_at DESC
        LIMIT 1) t)                               AS disbursement,
    (SELECT coalesce(json_agg(t), '[]') FROM (
       SELECT DISTINCT ON (decision_type) *
         FROM underwriting_decisions
        WHERE application_id = $1
        ORDER BY decision_type, decided_at DESC) t) AS decisions
`;

/**
 * Loads every row the rule engine needs for one application.
 */
async function loadWorkflowDataset(db, application) {
  const applicantIds = [application.borrower_id, application.coborrower_id].filter(Boolean);

  const result = await run(db, DATASET_SQL, [application.id, applicantIds]);
  const data = result.rows[0] ?? {};
  const of = (key) => data[key] ?? [];

  const applicantById = new Map(of("applicants").map((row) => [row.id, row]));
  const addressByApplicant = new Map(of("addresses").map((row) => [row.applicant_id, row]));
  const employmentByApplicant = groupByApplicant(of("employments"));
  const businessByApplicant = groupByApplicant(of("businesses"));
  const bankByApplicant = groupByApplicant(of("bank_accounts"));
  const documentsByApplicant = groupDocuments(of("documents"));

  const kycByApplicant = new Map();
  for (const row of of("kyc_checks")) {
    if (!kycByApplicant.has(row.applicant_id)) kycByApplicant.set(row.applicant_id, {});
    kycByApplicant.get(row.applicant_id)[row.check_type] = row;
  }

  const consentByType = {};
  for (const row of of("consents")) consentByType[row.consent_type] = row;

  const decisionsByType = {};
  for (const row of of("decisions")) decisionsByType[row.decision_type] = row;

  const credit = of("credit")[0] ?? null;
  const offer = of("offer")[0] ?? null;
  const disbursement = of("disbursement")[0] ?? null;

  return {
    application,
    borrower: application.borrower_id ? applicantById.get(application.borrower_id) ?? null : null,
    coborrower: application.coborrower_id ? applicantById.get(application.coborrower_id) ?? null : null,
    borrowerAddress: application.borrower_id
      ? addressByApplicant.get(application.borrower_id) ?? null
      : null,
    coborrowerAddress: application.coborrower_id
      ? addressByApplicant.get(application.coborrower_id) ?? null
      : null,
    borrowerEmployment: application.borrower_id
      ? employmentByApplicant.get(application.borrower_id) ?? null
      : null,
    coborrowerEmployment: application.coborrower_id
      ? employmentByApplicant.get(application.coborrower_id) ?? null
      : null,
    borrowerBusiness: application.borrower_id
      ? businessByApplicant.get(application.borrower_id) ?? null
      : null,
    coborrowerBusiness: application.coborrower_id
      ? businessByApplicant.get(application.coborrower_id) ?? null
      : null,
    borrowerKyc: application.borrower_id ? kycByApplicant.get(application.borrower_id) ?? {} : {},
    coborrowerKyc: application.coborrower_id ? kycByApplicant.get(application.coborrower_id) ?? {} : {},
    borrowerBank: application.borrower_id ? bankByApplicant.get(application.borrower_id) ?? null : null,
    coborrowerBank: application.coborrower_id
      ? bankByApplicant.get(application.coborrower_id) ?? null
      : null,
    borrowerDocuments: application.borrower_id
      ? documentsByApplicant.get(application.borrower_id) ?? {}
      : {},
    coborrowerDocuments: application.coborrower_id
      ? documentsByApplicant.get(application.coborrower_id) ?? {}
      : {},
    consents: consentByType,
    credit,
    offer,
    disbursement,
    decisions: decisionsByType,
  };
}

module.exports = {
  createApplication,
  findCreationRequest,
  createCreationRequest,
  updateCreationRequestSession,
  findById,
  findByWorkflowId,
  lockById,
  listApplications,
  updateState,
  setBorrower,
  setCoborrower,
  setRequiresCoborrower,
  setRequestedAmount,
  nextEventSequence,
  appendEvent,
  findEventByClientId,
  listEvents,
  loadHistory,
  loadWorkflowDataset,
};
