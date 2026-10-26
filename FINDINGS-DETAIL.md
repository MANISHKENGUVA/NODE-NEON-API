# Findings Detail â€” node-neon-api

Detailed records for all 8 Phase 4/Phase 5 records. Evidence and line references are preserved exactly as recorded in findings.json and independently re-verified in PHASE5-VERIFICATION.md. No severity is assigned. No new findings are introduced.

### H-01 / V-01

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Unauthenticated database read/write endpoints
- **Category:** Broken access control â€” missing authentication
- **Source evidence (exact, from findings.json):**
  - src/middleware/index.js:7-18 chain ALS, cors origin *, helmet, morgan, json, urlencoded; no auth middleware
  - src/index.js:11,32-34 applyMiddleware then app.use /api routes; no auth gate
  - src/routes/index.js:8-9,11,20,29 and src/routes/workflow.js:21,38,55,68,89,105,121,196,205,240-241,255,285 handlers reach sql with no user or token check
  - package.json:12-18 no auth validation or rate-limit deps; zero auth hits in src
- **Affected component:** src/middleware/index.js; src/index.js; src/routes/index.js; src/routes/workflow.js
- **Data flow:** Unauthenticated HTTP client to Express handler with no credential check to neon sql tagged-template query to Postgres to res.json row. Examples: GET /api/users SELECT users; POST /api/users INSERT INTO users; GET /api/workflow/identifiers SELECT star from workflow_identifiers.
- **Attacker-controlled input:** Any unauthenticated remote HTTP caller (request method, path, parameters, and body).
- **Security-sensitive sink/resource:** neon sql tagged-template queries against tables users, workflow_identifiers, workflow_events, work_identifiers, domain_datastore.
- **Security significance:** Unauthorized read plus create and update of records without credential. Exposes all workflow and user data operations to the internet; enabler for IDOR, event forgery, and context manipulation findings.
- **Scope limitations:** Source-only verification. No live requests were made.
- **Unresolved assumptions:** Whether a given deployment sits behind an external authentication gateway is unproven; no such evidence exists in source, and no live testing was performed.
- **Remediation:** Enforce authentication on /api with API key or JWT verification and default deny; restrict CORS to an allowlist; add per-workflow authorization; add rate limiting.

### H-02 / V-02

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Workflow IDOR and missing ownership authorization
- **Category:** Broken access control â€” IDOR / missing ownership check
- **Source evidence (exact, from findings.json):**
  - src/services/workflowIdentifier.js:99-127 getWorkflowIdentifier lookup by identifier only, 404 if missing, no principal
  - src/services/workflowIdentifier.js:132-166 listWorkflowIdentifiers SELECT star with status and workflow_id only
  - src/services/workflowIdentifier.js:171-207 updateWorkflowIdentifier existence check only then UPDATE and RETURNING star
  - src/services/workflowDecider.js:142-156 fetchWorkflowRow existence check only; 374-394 and 533-549 accept WORKFLOW_ID or workflow_identifier or workflow_id or id
  - src/services/workflowIdentifier.js:8-11 identifier uses Date.now plus Math.random, not CSPRNG
- **Affected component:** src/services/workflowIdentifier.js; src/services/workflowDecider.js; src/routes/workflow.js
- **Data flow:** Request identifier from params query or body to get list update or fetchWorkflowRow to sql WHERE workflow_identifier or workflow_id to existence-only check to full row plus events returned or updated. GET /identifiers lists all workflows without auth so no guessing is needed.
- **Attacker-controlled input:** Any unauthenticated caller acting against another workflow owner or data subject; identifier values from params, query, or body.
- **Security-sensitive sink/resource:** Arbitrary workflow_identifiers record plus workflow_events history plus work_identifiers events plus domain_datastore data.
- **Security significance:** Cross-workflow read, update, advance, or fork of any loan workflow.
- **Scope limitations:** Source-only verification. No live requests were made; no cross-tenant data was accessed during the audit.
- **Unresolved assumptions:** Whether any deployment-level authorization layer exists outside the source was not tested; no such evidence exists in source.
- **Remediation:** Require authenticated principal; add owner or tenant column and enforce WHERE identifier plus owner equals auth subject; use crypto.randomUUID for identifiers; remove or protect bulk GET /identifiers.

### H-03 / V-03

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Unauthenticated DDL-via-POST endpoints
- **Category:** Broken access control â€” unauthenticated schema-management surface
- **Source evidence (exact, from findings.json):**
  - src/routes/workflow.js:55-62 POST /createdb calls createWorkIdentifierTable with no auth
  - src/routes/workflow.js:285-292 POST /createDomainDatastoreTable calls createDomainDatastoreTable with no auth
  - src/config/db.js:67-78 CREATE TABLE IF NOT EXISTS work_identifiers fixed string
  - src/services/domainDatastore.js:8-19 CREATE TABLE IF NOT EXISTS domain_datastore fixed string
  - src/config/db.js:10-65 initDb runs same DDL at boot so runtime role already holds CREATE
- **Affected component:** src/routes/workflow.js; src/config/db.js; src/services/domainDatastore.js
- **Data flow:** Unauthenticated POST to /createdb or /createDomainDatastoreTable to service function to sql CREATE TABLE IF NOT EXISTS to Postgres schema. Statements are fixed IF NOT EXISTS strings, so no arbitrary DDL demonstrated.
- **Attacker-controlled input:** Any unauthenticated remote HTTP caller (triggering the POST routes; no body content controls the DDL text).
- **Security-sensitive sink/resource:** Database schema; work_identifiers and domain_datastore tables.
- **Security significance:** Unauthenticated triggering of schema operations plus disclosure of table names and structure in success messages; schema-management surface exposed; confirms table structure; wasted DB work.
- **Scope limitations:** The DDL strings are fixed IF NOT EXISTS statements; arbitrary DDL was NOT demonstrated. Source-only verification; no live requests were made.
- **Unresolved assumptions:** Runtime database role privileges in any specific deployment were not tested live; source shows the boot path already runs the same DDL.
- **Remediation:** Delete both POST DDL routes; run DDL only via boot migration or offline migration with owner role; use a least-privilege runtime DB user without CREATE.

### H-04 / V-04

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Workflow event forgery and state manipulation via self-asserted actor and step
- **Category:** Business logic abuse â€” event forgery / state manipulation
- **Phase 3 correction (preserved; independently verified in Phase 5):** Phase 3 correction preserved: stamped actor is overwritten from the flow definition when the asserted step is known (getActorForState(step) fallback requestActor). The caller can still assert an attacker-chosen valid step against an arbitrary workflow with no ownership or sequence enforcement.
- **Source evidence (exact, from findings.json):**
  - src/routes/workflow.js:121-194 recorder-decider plus 196-203 recorder events plus 205-212 decider plus 219-238 navigator plus 255-279 eventCreaterAndProcesser all pass req.body into realdecider decideNextState appendWorkflowEvent
  - src/services/workflowDecider.js:292-300 authorativeActor equals getActorForState(completedStep) fallback requestActor
  - src/services/workflowDecider.js:506-524 resolveStateKey exact then singular plural then case-insensitive
  - src/services/workflowDecider.js:533-580 realdecider validates presence only, fetches row by existence, publishes transition, then decisionManager without ownership or successor check
  - src/services/workflowDecider.js:596-629 decisionManager never calls resolveNodeForActor; actor check exists only in read-path decideNextState
  - src/services/workflowRecorder.js:85-123 appendWorkflowEvent appends verbatim req.body as JSON; routing heuristic is includes dash and length 36
  - src/services/eventPublisher.js:16-50 appends eventName to events.states and sets currentState equal eventName
- **Affected component:** src/routes/workflow.js; src/services/workflowDecider.js; src/services/workflowRecorder.js; src/services/eventPublisher.js
- **Data flow:** Attacker body with WORKFLOW_ID plus WORKFLOW_ACTOR plus CURRENTCOMPLETEDSTEP to resolveStateKey to fetchWorkflowRow existence-only to publishStateTransition with definition-derived actor to eventPublisher append to states and currentState to decisionManager edge evaluation for asserted step. No check that requester owns the step or that the step follows stored currentState.
- **Attacker-controlled input:** Any unauthenticated caller acting against another workflow borrower, lender, or manager; body fields WORKFLOW_ID, WORKFLOW_ACTOR, CURRENTCOMPLETEDSTEP.
- **Security-sensitive sink/resource:** work_identifiers events states and currentState; workflow_events events_json.
- **Security significance:** Forge advance rewind or fork of any workflow history and force edge evaluation from an attacker-chosen node. Workflow integrity loss: fabricated state transitions and manipulated loan progression.
- **Scope limitations:** Source-only verification; no live events were forged during the audit. The Phase 3 correction limits the actor claim: the stamped actor is overwritten from the flow definition when the asserted step is known.
- **Unresolved assumptions:** Whether an external layer restricts write routes in a given deployment was not tested and is not evidenced in source.
- **Remediation:** Authenticate WORKFLOW_ACTOR; enforce getActorForState(step) equals authenticated actor and step is a legal successor of stored currentState; schema-validate event bodies instead of verbatim append.

### H-05 / V-05

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Rule-engine context manipulation through client-controlled formData
- **Category:** Business logic abuse â€” trust boundary / client-controlled decision input
- **Source evidence (exact, from findings.json):**
  - src/routes/workflow.js:259-272 formData defaults to empty object then dispatchEventTypeStorage then realdecider with no null guard
  - src/services/domainDatastore.js:565-575 allowlist EVENTYPE_HANDLER_MAP; unknown eventType returns null but route continues
  - src/services/domainDatastore.js:83-109 ADDRESS hardcodes isValid true and pincodeVerified true
  - src/services/domainDatastore.js:111-127 KYC defaults aadharUploaded and panUploaded to true
  - src/services/domainDatastore.js:225,243,282 status undefined maps to VERIFIED for PAN AADHAR BANK
  - src/services/domainDatastore.js:153,168-169,264,268,301-302 salary business bank statement document consent use not-false or fallback-true defaults
  - src/services/domainDatastore.js:509-532 upsertAllDomains deep merge then write; 586-601 buildWorkflowContext returns stored data as rule context
  - src/services/ruleEngine.js:1-62 dot-path field lookup with equals not-equals greater less operators
  - FLOWDESINGER.json ED02 ADDRESS flags, ED03 ED04 DOCUMENTS identity flags, plus ELIGIBILITY and verification gates
- **Affected component:** src/routes/workflow.js; src/services/domainDatastore.js; src/services/workflowDecider.js; src/services/ruleEngine.js; src/FLOWDESIGNER/FLOWDESINGER.json
- **Data flow:** Unauthenticated req.body formData to callDynamic eventype handler to patch to upsertAllDomains into domain_datastore data to buildWorkflowContext to evaluateRuleEngine context against edges for asserted step to nextState. Hardcoded and fallback-true flags auto-satisfy gates such as ADDRESS_INFO_SUBMITTED satisfying ED02. Server creates the insecure defaults.
- **Attacker-controlled input:** Any unauthenticated caller; client-controlled req.body formData fields. Victim is lending-decision integrity and all workflow participants.
- **Security-sensitive sink/resource:** Authoritative domain_datastore data context and ED01 through ED61 transitions.
- **Security significance:** Caller-controlled verification and consent flags become trusted decision inputs and drive next-node outcomes. Decision bypass: unverified address KYC bank consent and approval signals can be asserted as passing.
- **Scope limitations:** Source-only verification; rule outcomes were not executed live against a database.
- **Unresolved assumptions:** Whether any deployment adds server-side attestation of these flags was not tested and is not evidenced in source.
- **Remediation:** Fail closed by default with false FAILED or PENDING; never derive VERIFIED or consent from absent client fields; separate client form fields from verifier-attested fields written only by trusted services; schema-validate formData; abort when dispatch returns null.

### H-07 / V-07

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Credential-shaped DATABASE_URL exposed in tracked .env.example
- **Category:** Sensitive data exposure â€” credential-shaped secret in tracked file
- **Validity testing note (exact, from findings.json):** Credential validity was NOT tested. No connection to Neon was attempted. Exposure of the credential-shaped secret in the tracked repository is itself the confirmed issue.
- **Source evidence (exact, from findings.json):**
  - .env.example:2 DATABASE_URL postgresql URI for user neondb_owner with npg_-prefixed password on Neon host ep-shiny-violet-aynt6xo8-pooler.c-5.us-east-2.aws.neon.tech database neondb
  - .gitignore:2 ignores .env but the example file carrying the secret is tracked
  - src/config/db.js:4-8 this exact DATABASE_URL authenticates the neon client as neondb_owner
- **Affected component:** .env.example; src/config/db.js
- **Data flow:** Tracked .env.example containing credential-shaped DATABASE_URL to anyone with repository read access such as clone fork or CI logs to potential authentication as neondb_owner to Neon neondb. No live authentication step was performed.
- **Attacker-controlled input:** None required; anyone with repository read access obtains the value.
- **Security-sensitive sink/resource:** Neon neondb database accessed as neondb_owner.
- **Security significance:** Disclosure of a privileged-looking database credential; potential full database access if the credential is live; repository-wide secret exposure â€” treat as compromised until rotated.
- **Scope limitations:** Credential exposure confirmed. Credential validity was NOT tested. No database connection was attempted. Whether the credential is live is unknown.
- **Unresolved assumptions:** Validity and current privilege level of the credential are unresolved by design; the record treats exposure itself as the confirmed issue.
- **Remediation:** Immediately rotate and revoke the exposed password; replace the file value with a non-secret placeholder; purge or rotate given git history retention; add secret scanning and a pre-commit hook.

### H-08 / V-08

- **Status:** VALIDATED (Phase 5: VERIFIED)
- **Title:** Sensitive PII logging and verbose error disclosure
- **Category:** Information disclosure â€” sensitive data logging and verbose errors
- **Source evidence (exact, from findings.json):**
  - src/routes/workflow.js:257 full req.body dump; 264 full domain storage row dump
  - src/services/domainDatastore.js:26,40,510,530,599 upsert dispatch row-after-upsert and built-context full dumps
  - src/services/workflowDecider.js:327,383,540,597 full event and context dumps; src/services/ruleEngine.js:15,43,51 condition and CONTECT dumps
  - src/services/eventPublisher.js:32,52 full event and state-count logs
  - PII persisted upstream in domainDatastore handlers: fullName fathersName mothersName dateOfBirth gender email mobileNumber aadhaarNumber panNumber loanPurpose monthlyIncome regNumber fileUrl
  - src/middleware/errorHandler.js:8-15 err.message returned verbatim plus console.error full error; notFound reflects method plus originalUrl
  - src/middleware/index.js:15 morgan dev request logging
- **Affected component:** src/routes/workflow.js; src/services/domainDatastore.js; src/services/workflowDecider.js; src/services/ruleEngine.js; src/services/eventPublisher.js; src/middleware/errorHandler.js; src/middleware/index.js
- **Data flow:** Request body with PII and formData to console.log of body row context and event to stdout log files and aggregators. Separately driver or DB err.message returned verbatim to unauthenticated caller through errorHandler, and morgan dev logs request lines.
- **Attacker-controlled input:** Request bodies carrying PII and formData (any caller); unauthenticated callers who trigger error responses.
- **Security-sensitive sink/resource:** Aadhaar PAN date of birth contact financial and loan PII confidentiality; internal driver and DB error detail; stdout logs and HTTP error responses.
- **Security significance:** PII spreads beyond Postgres into logs; internal error detail disclosed to unauthenticated callers. Privacy breach surface plus operational-secret leakage; heightened regulatory and account-takeover-adjacent risk.
- **Scope limitations:** Source-only verification; no live error responses were elicited. Server-side logging vs client-facing error responses are distinguished as in the verified record.
- **Unresolved assumptions:** Log aggregator retention and access controls in any deployment were not tested.
- **Remediation:** Remove full-body row and context dumps; log only IDs with PII scrubbing; return generic 500 messages; disable morgan dev in production.

### H-06 (REJECTED)

- **Status:** REJECTED (Phase 5: rejection independently confirmed â€” VERIFIED)
- **Title:** SQL injection
- **Category:** Injection (candidate) â€” rejected
- **Source evidence:** No source evidence recorded in findings.json because no injection sink was found. Phase 5 independently re-enumerated all 33 sql tagged-template sites in the source.
- **Data flow:** Not applicable â€” no injection data flow exists. All values including status, workflow_id, identifiers, limit, offset, and JSON strings flow through neon sql tagged-template parameters.
- **Attacker-controlled input:** Not applicable â€” no concatenated or dynamically constructed SQL path was found for any input.
- **Security-sensitive sink/resource:** Not applicable â€” all sql tagged-template sites observed are parameterized; LIMIT/OFFSET via parameters; JSON via bound parameters with ::jsonb casts.
- **Security significance:** None. H-06 is REJECTED and is not an active vulnerability.
- **Phase 5 independent rejection (exact):** all 33 sql tagged-template sites re-enumerated; parameterized/bound values observed; no concatenated SQL; no dynamic table or column names; LIMIT/OFFSET and JSON values are bound; LIMIT NaN is robustness only; SQL injection candidate rejected; no replacement finding invented.
- **Recorded reason (exact, from findings.json):** No SQL injection sink found. All values including status, workflow_id, identifiers, limit, offset, and JSON strings flow through neon sql tagged-template parameters. No string-concatenated SQL and no dynamic table or column names were found. LIMIT OFFSET NaN is a robustness issue, not an injection primitive.
- **Scope limitations:** Source-only verification. No replacement SQL injection finding was invented.
- **Unresolved assumptions:** None carried forward; the rejection stands as verified.
- **Remediation:** None required for this candidate. Continue using parameterized queries consistently.
