# Security Audit Report â€” node-neon-api

## Executive Summary

This report presents the final target-neutral results of a source-first security audit of the node-neon-api project. All findings were derived from read-only static analysis of the project source. No live exploitation or dynamic testing of any kind was performed.

Scope was limited to node-neon-api only. Phase 5 independently verified every Phase 4 record against reopened source evidence. The final audit state is:

- 7 findings are VALIDATED
- 1 candidate is REJECTED
- 0 discrepancies were found between Phase 4 records and Phase 5 verification
- No severity was assigned to any finding
- No live exploitation or testing was performed

Phase 5 Result: PASS

## Scope

Target: node-neon-api

Path: C:\Users\MANISH KENGUVA\Documents\projects\node-neon-api

Only node-neon-api audit artifacts and source evidence were used. The authoritative records are findings.json (Phase 4 structured output) and PHASE5-VERIFICATION.md (Phase 5 independent verification).

REACTGOPRO, REACTALLGOPRO/GOPRO, and all frontend findings were explicitly outside this audit and are not included in this report.

## Methodology

The audit was conducted in six phases:

1. Reconnaissance
2. Coverage-led hunting
3. Candidate validation
4. Structured output
5. Independent record verification
6. Final target-neutral reporting

Phase 5 Result: PASS

8/8 records verified with 0 discrepancies.

## Findings Summary

| Finding ID | Candidate ID | Status | Title |
| --- | --- | --- | --- |
| H-01 | V-01 | VALIDATED | Unauthenticated database read/write endpoints |
| H-02 | V-02 | VALIDATED | Workflow IDOR and missing ownership authorization |
| H-03 | V-03 | VALIDATED | Unauthenticated DDL-via-POST endpoints |
| H-04 | V-04 | VALIDATED | Workflow event forgery and state manipulation via self-asserted actor and step |
| H-05 | V-05 | VALIDATED | Rule-engine context manipulation through client-controlled formData |
| H-07 | V-07 | VALIDATED | Credential-shaped DATABASE_URL exposed in tracked .env.example |
| H-08 | V-08 | VALIDATED | Sensitive PII logging and verbose error disclosure |
| H-06 | n/a (rejected candidate) | REJECTED | SQL injection candidate |

No severity is assigned to any record in this report.

## Validated Findings

### H-01 / V-01
Unauthenticated database read/write

- **Affected source area:** src/middleware/index.js; src/index.js; src/routes/index.js; src/routes/workflow.js
- **Concise evidence:** src/middleware/index.js:7-18 chains ALS, cors (origin *), helmet, morgan, json, urlencoded with no auth middleware. src/index.js:11,32-34 applies middleware then mounts /api routes with no auth gate. Handlers at src/routes/index.js:8-9,11,20,29 and src/routes/workflow.js:21,38,55,68,89,105,121,196,205,240-241,255,285 reach sql with no user or token check. package.json:12-18 shows no auth validation or rate-limit dependencies and there are zero auth hits in src.
- **Attacker-controlled input:** Any unauthenticated remote HTTP caller controls method, path, parameters, and body.
- **Security-sensitive sink/resource:** neon sql tagged-template queries against Postgres tables users, workflow_identifiers, workflow_events, work_identifiers, domain_datastore; rows returned via res.json.
- **Security significance:** Unauthorized read plus create and update of records without a credential. Exposes all workflow and user data operations; acts as an enabler for the IDOR, event forgery, and context manipulation findings.
- **Unresolved assumptions:** Verification was source-only; whether an external gateway provides authentication in a given deployment was not tested and is not evidenced in source.
- **Remediation summary:** Enforce authentication on /api with API key or JWT verification and default deny; restrict CORS to an allowlist; add per-workflow authorization; add rate limiting.

### H-02 / V-02
IDOR / workflow ownership

- **Affected source area:** src/services/workflowIdentifier.js; src/services/workflowDecider.js; src/routes/workflow.js
- **Concise evidence:** src/services/workflowIdentifier.js:99-127 getWorkflowIdentifier looks up by identifier only (404 if missing, no principal). 132-166 listWorkflowIdentifiers does SELECT star filtered only by status and workflow_id. 171-207 updateWorkflowIdentifier performs an existence check only, then UPDATE and RETURNING star. src/services/workflowDecider.js:142-156 fetchWorkflowRow is existence-check-only; 374-394 and 533-549 accept WORKFLOW_ID or workflow_identifier or workflow_id or id. src/services/workflowIdentifier.js:8-11 identifier uses Date.now plus Math.random, not CSPRNG.
- **Attacker-controlled input:** Request identifier taken from params, query, or body; GET /identifiers lists all workflows without auth, so guessing is not required.
- **Security-sensitive sink/resource:** Arbitrary workflow_identifiers record, workflow_events history, work_identifiers events, and domain_datastore data via sql WHERE workflow_identifier / workflow_id.
- **Security significance:** Cross-workflow read, update, advance, or fork of any loan workflow by listing or knowing its identifier.
- **Unresolved assumptions:** No owner or tenant column was found in source; no live testing confirmed behavior against a populated production dataset.
- **Remediation summary:** Require an authenticated principal; add an owner or tenant column and enforce WHERE identifier plus owner equals auth subject; use crypto.randomUUID for identifiers; remove or protect bulk GET /identifiers.

### H-03 / V-03
Unauthenticated DDL POST

- **Affected source area:** src/routes/workflow.js; src/config/db.js; src/services/domainDatastore.js
- **Concise evidence:** src/routes/workflow.js:55-62 POST /createdb calls createWorkIdentifierTable with no auth. src/routes/workflow.js:285-292 POST /createDomainDatastoreTable calls createDomainDatastoreTable with no auth. src/config/db.js:67-78 is a fixed CREATE TABLE IF NOT EXISTS work_identifiers string; src/services/domainDatastore.js:8-19 is a fixed CREATE TABLE IF NOT EXISTS domain_datastore string. src/config/db.js:10-65 runs the same DDL at boot, so the runtime role already holds CREATE.
- **Attacker-controlled input:** Any unauthenticated remote HTTP caller can trigger the two POST routes; request body content does not control the DDL text.
- **Security-sensitive sink/resource:** Database schema â€” work_identifiers and domain_datastore tables.
- **Security significance:** Schema-management surface exposed to unauthenticated callers; success messages disclose table names and structure; wasted DB work. The statements are fixed IF NOT EXISTS strings, so no arbitrary DDL is demonstrated.
- **Unresolved assumptions:** Actual runtime role privileges in any specific deployment were not tested live; source shows the boot path already runs the same DDL.
- **Remediation summary:** Delete both POST DDL routes; run DDL only via boot migration or offline migration with owner role; use a least-privilege runtime DB user without CREATE.

### H-04 / V-04
Event/state manipulation

- **Affected source area:** src/routes/workflow.js; src/services/workflowDecider.js; src/services/workflowRecorder.js; src/services/eventPublisher.js
- **Phase 3 actor-overwrite correction (preserved, independently verified in Phase 5):** The stamped actor is overwritten from the flow definition when the asserted step is known (getActorForState(step) fallback requestActor). The caller can still assert an attacker-chosen valid step against an arbitrary workflow with no ownership or sequence enforcement.
- **Concise evidence:** src/routes/workflow.js:121-194 recorder-decider plus 196-203 recorder events plus 205-212 decider plus 219-238 navigator plus 255-279 eventCreaterAndProcesser all pass req.body into realdecider decideNextState appendWorkflowEvent. src/services/workflowDecider.js:292-300 authorativeActor equals getActorForState(completedStep) fallback requestActor. src/services/workflowDecider.js:506-524 resolveStateKey exact then singular plural then case-insensitive. src/services/workflowDecider.js:533-580 realdecider validates presence only, fetches row by existence, publishes transition, then decisionManager without ownership or successor check. src/services/workflowDecider.js:596-629 decisionManager never calls resolveNodeForActor; actor check exists only in read-path decideNextState. src/services/workflowRecorder.js:85-123 appendWorkflowEvent appends verbatim req.body as JSON; routing heuristic is includes dash and length 36. src/services/eventPublisher.js:16-50 appends eventName to events.states and sets currentState equal eventName.
- **Attacker-controlled input:** Attacker body with WORKFLOW_ID plus WORKFLOW_ACTOR plus CURRENTCOMPLETEDSTEP on unauthenticated write routes.
- **Security-sensitive sink/resource:** work_identifiers events states and currentState; workflow_events events_json.
- **Security significance:** Forge, advance, rewind, or fork of any workflow history and forced edge evaluation from an attacker-chosen node. Workflow integrity loss: fabricated state transitions and manipulated loan progression. There is no check that the requester owns the step or that the step follows stored currentState.
- **Unresolved assumptions:** Source-only verification; whether any deployment-level control restricts write routes was not tested and is not evidenced in source.
- **Remediation summary:** Authenticate WORKFLOW_ACTOR; enforce getActorForState(step) equals authenticated actor and that the step is a legal successor of stored currentState; schema-validate event bodies instead of verbatim append.

### H-05 / V-05
Rule-engine formData trust

- **Affected source area:** src/routes/workflow.js; src/services/domainDatastore.js; src/services/workflowDecider.js; src/services/ruleEngine.js; src/FLOWDESIGNER/FLOWDESINGER.json
- **Concise evidence:** src/routes/workflow.js:259-272 takes formData (defaulting to an empty object) into dispatchEventTypeStorage then realdecider with no null guard. src/services/domainDatastore.js:565-575 allowlists EVENTYPE_HANDLER_MAP; unknown eventType returns null but the route continues. src/services/domainDatastore.js:83-109 hardcodes ADDRESS isValid true and pincodeVerified true. src/services/domainDatastore.js:111-127 defaults aadharUploaded and panUploaded to true. src/services/domainDatastore.js:225,243,282 maps undefined status to VERIFIED for PAN AADHAR BANK. src/services/domainDatastore.js:153,168-169,264,268,301-302 use not-false or fallback-true defaults for salary, business, bank statement, document, and consent. src/services/domainDatastore.js:509-532 upsertAllDomains deep merges then writes; 586-601 buildWorkflowContext returns stored data as rule context. src/services/ruleEngine.js:1-62 performs dot-path field lookup with equals/not-equals/greater/less operators. FLOWDESINGER.json ED02 ADDRESS flags, ED03 ED04 DOCUMENTS identity flags, plus ELIGIBILITY and verification gates. Server creates the insecure defaults.
- **Attacker-controlled input:** Any unauthenticated caller; client-controlled req.body formData fields.
- **Security-sensitive sink/resource:** Authoritative domain_datastore data context and ED01 through ED61 transitions consumed by the rule engine.
- **Security significance:** Caller-controlled verification and consent flags become trusted decision inputs and drive next-node outcomes; unverified address, KYC, bank, consent, and approval signals can be asserted as passing.
- **Unresolved assumptions:** Whether any deployment adds server-side attestation of these flags was not tested and is not evidenced in source; rule outcomes were not executed live.
- **Remediation summary:** Fail closed by default with false/FAILED/PENDING; never derive VERIFIED or consent from absent client fields; separate client form fields from verifier-attested fields written only by trusted services; schema-validate formData; abort when dispatch returns null.

### H-07 / V-07
Credential-shaped DATABASE_URL in tracked .env.example

- **Affected source area:** .env.example; src/config/db.js
- **Concise evidence:** .env.example:2 contains a DATABASE_URL PostgreSQL URI for user neondb_owner with an npg_-prefixed password on Neon host ep-shiny-violet-aynt6xo8-pooler.c-5.us-east-2.aws.neon.tech database neondb. .gitignore:2 ignores .env but the example file carrying the secret is tracked. src/config/db.js:4-8 uses this exact DATABASE_URL to authenticate the neon client as neondb_owner.
- **Attacker-controlled input:** None required; anyone with repository read access (clone, fork, or CI logs) obtains the credential-shaped value.
- **Security-sensitive sink/resource:** Neon neondb database accessed as neondb_owner.
- **Security significance:** Disclosure of a privileged-looking database credential; potential full database access if the credential is live; repository-wide secret exposure â€” treat as compromised until rotated. **Credential exposure was confirmed, but credential validity was NOT tested and no database connection was attempted.**
- **Unresolved assumptions:** Whether the credential is currently valid/live is unknown because validity testing was explicitly out of scope; no connection to Neon was attempted.
- **Remediation summary:** Immediately rotate and revoke the exposed password; replace the file value with a non-secret placeholder; purge or rotate given git history retention; add secret scanning and a pre-commit hook.

### H-08 / V-08
PII logging / verbose errors

- **Affected source area:** src/routes/workflow.js; src/services/domainDatastore.js; src/services/workflowDecider.js; src/services/ruleEngine.js; src/services/eventPublisher.js; src/middleware/errorHandler.js; src/middleware/index.js
- **Concise evidence:** src/routes/workflow.js:257 full req.body dump; 264 full domain storage row dump. src/services/domainDatastore.js:26,40,510,530,599 upsert dispatch row-after-upsert and built-context full dumps. src/services/workflowDecider.js:327,383,540,597 full event and context dumps; src/services/ruleEngine.js:15,43,51 condition and CONTECT dumps. src/services/eventPublisher.js:32,52 full event and state-count logs. PII persisted upstream in domainDatastore handlers: fullName, fathersName, mothersName, dateOfBirth, gender, email, mobileNumber, aadhaarNumber, panNumber, loanPurpose, monthlyIncome, regNumber, fileUrl. src/middleware/errorHandler.js:8-15 returns err.message verbatim plus console.error full error; notFound reflects method plus originalUrl. src/middleware/index.js:15 morgan dev request logging.
- **Attacker-controlled input:** Request bodies carrying PII and formData (from any caller); unauthenticated callers triggering error responses.
- **Security-sensitive sink/resource:** stdout log files and aggregators (server-side) and HTTP error responses (client-facing); Aadhaar, PAN, date of birth, contact, financial, and loan PII confidentiality; internal driver and DB error detail.
- **Security significance:** PII spreads beyond Postgres into logs; internal error detail is disclosed to unauthenticated callers. Privacy breach surface plus operational-secret leakage.
- **Unresolved assumptions:** Retention and access controls of log aggregators in any deployment were not tested; server-side log statements vs client-facing error responses are distinguished as recorded in the verified evidence.
- **Remediation summary:** Remove full-body, row, and context dumps; log only IDs with PII scrubbing; return generic 500 messages; disable morgan dev in production.

## Rejected Candidate

### H-06 â€” SQL injection

H-06 was a SQL injection candidate proposed during hunting. It is REJECTED and is not an active vulnerability.

Phase 5 independently re-verified the rejection:

- all 33 sql tagged-template sites were re-enumerated
- parameterized/bound values observed for all inputs
- no concatenated SQL was found
- no dynamic table or column names were found
- LIMIT/OFFSET values flow through bound parameters
- JSON values flow through bound parameters with ::jsonb casts
- LIMIT/OFFSET NaN is a robustness issue only, not an injection primitive
- SQL injection candidate rejected; no replacement SQL injection finding was invented

Recorded reason (findings.json): "No SQL injection sink found. All values including status, workflow_id, identifiers, limit, offset, and JSON strings flow through neon sql tagged-template parameters. No string-concatenated SQL and no dynamic table or column names were found. LIMIT OFFSET NaN is a robustness issue, not an injection primitive."

## Cross-Cutting Remediation Themes

The verified findings support the following remediation themes:

- Enforce authentication and authorization on sensitive API routes
- Enforce workflow/resource ownership server-side
- Remove unauthenticated DDL capabilities
- Enforce server-side workflow state transitions
- Do not trust client-controlled formData for security decisions
- Remove credential-shaped secrets from tracked example files
- Rotate any real exposed credential if one is later confirmed
- Minimize PII in logs
- Avoid verbose error responses
- Use parameterized queries consistently

No claim is made that the H-07 credential is valid, because it was not tested. No additional vulnerabilities are claimed beyond the seven validated findings.

## Limitations

- Source-only verification
- No live requests
- No localhost requests
- No external requests
- No exploitation
- No database connection
- H-07 credential validity was not tested
- Production deployment was not independently tested unless existing audit evidence explicitly proves it
- No severity scoring was assigned

## Phase 6 Artifact Validation

- findings.json parsed successfully after a Phase 6 syntax repair: one trailing comma after the final finding object made the file invalid JSON; only that comma was removed, with no change to any record content, field values, statuses, or counts
- findings.json structure: 7 findings, all validation_status CONFIRMED (V-01, V-02, V-03, V-04, V-05, V-07, V-08); 1 rejected record (H-06, REJECTED); 0 NEEDS_VALIDATION records
- No severity fields exist anywhere in findings.json; no severity values are assigned in any Phase 6 artifact
- All 7 finding titles and the exact H-06 rejection reason appear consistently in REPORT.md and FINDINGS-DETAIL.md
- No live-probe instructions appear in any Phase 6 artifact
- The skill's report-schema.json and validate-findings.cjs validators were not available in this environment; equivalent structural validation was performed and passed as listed above

## Final Audit State

Phase 5 Result: PASS

Records:
- 7 VALIDATED
- 1 REJECTED
- 0 discrepancies
