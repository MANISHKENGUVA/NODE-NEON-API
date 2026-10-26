/**
 * testSessionAccess.js
 *
 * End-to-end validation of the generic session + access-control + optional
 * authentication architecture. Run with:  npm test
 *
 * Covers:
 *   1  Anonymous workflow session creation          8  Protected-node access after auth
 *   2  Multiple public nodes                        9  Actor session expiration
 *   3  Public + CAPTCHA node                       10  Workflow session expiration
 *   4  Actor-protected node                        11  Client reload resolution
 *   5  AUTHENTICATION_REQUIRED response            12  Event publishing + next-node resolution
 *   6  Successful authentication                   13  Existing rule engine behaviour
 *   7  Actor session creation                      14  Latest-event / actor fallback behaviour
 *
 * The script spawns the API server with a test-friendly environment
 * (AUTH_DEV_MODE, stub captcha, short actor TTL) and drives it over HTTP.
 * It requires DATABASE_URL (project .env) exactly like the running server.
 */

"use strict";

// ── Test environment — set BEFORE requiring any app module ───────────────────
process.env.INTERNAL_SERVICE_TOKEN = "internal-test-secret";
process.env.CAPTCHA_PROVIDER = "stub";
process.env.CAPTCHA_DEV_TOKEN = "test-captcha-token";
process.env.AUTH_DEV_MODE = "true";
process.env.WORKFLOW_SESSION_TTL_MINUTES = "720";
process.env.ACTOR_SESSION_TTL_MINUTES = "0.1"; // 6 seconds — expiry test only

const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEST_PORT = 3999;
const BASE = `http://127.0.0.1:${TEST_PORT}/api`;
const CAPTCHA_TOKEN = "test-captcha-token";

// ── Flow definition keys used by the tests ───────────────────────────────────
const START = "BORROWER-DETAILS-V1-PERSONAL-INFO-V1";
const ADDRESS = "BORROWER-ADDRESS-V1-ADDRESS-INFO-V1";
const KYC_UPLOAD = "BORROWER-KYC-V1-KYC-UPLOAD-V1";
const FACE = "BORROWER-KYC-V1-FACE-VERIFICATION-V1";
const PAN_NODE = "BORROWER-KYC-V1-PAN-VERIFICATION-V1";
const AADHAR = "BORROWER-KYC-V1-AADHAR-VERIFICATION-V1";
const REJECTED = "BORROWER-STATUS-V1-REJECTED-V1";
const LENDER_ENTRY = "LENDER-CREDIT-V1-CREDIT-CHECK-V1";

// ── Tiny assertion harness ───────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, info) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${info !== undefined ? `  →  ${JSON.stringify(info)}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method, apiPath, body, headers = {}) {
  const resp = await fetch(`${BASE}${apiPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await resp.json();
  } catch {
    /* non-JSON response */
  }
  return { status: resp.status, body: json };
}

// ── Unit tests (no HTTP, no DB writes) ───────────────────────────────────────
async function runUnitTests() {
  console.log("\n── Unit: access policy + access resolver ──────────────────────────");
  const { normalizeAccess } = require("../src/access/accessPolicy");
  const { evaluateAccess } = require("../src/access/accessResolver");

  const pub = normalizeAccess({ type: "PUBLIC" });
  check("policy: PUBLIC", pub.type === "PUBLIC" && pub.captcha.required === false);

  const pubCap = normalizeAccess({ type: "PUBLIC", captcha: { required: true } });
  check("policy: PUBLIC + captcha", pubCap.type === "PUBLIC" && pubCap.captcha.required === true);

  const actor = normalizeAccess({
    type: "ACTOR",
    authentication: { required: true, methods: ["AADHAAR"] },
  });
  check(
    "policy: ACTOR AADHAAR",
    actor.type === "ACTOR" &&
      actor.authentication.required === true &&
      JSON.stringify(actor.authentication.methods) === JSON.stringify(["AADHAAR"])
  );

  const otp = normalizeAccess({
    type: "ACTOR",
    authentication: { required: true, methods: ["MOBILE_OTP"] },
  });
  check(
    "policy: ACTOR MOBILE_OTP",
    JSON.stringify(otp.authentication.methods) === JSON.stringify(["MOBILE_OTP"])
  );

  const internal = normalizeAccess({ type: "INTERNAL" });
  check("policy: INTERNAL", internal.type === "INTERNAL");

  const missing = normalizeAccess(null);
  check("policy: node without access block defaults to PUBLIC", missing.type === "PUBLIC");

  const intOk = await evaluateAccess({
    access: internal,
    session: null,
    internalToken: "internal-test-secret",
  });
  check("resolver: INTERNAL with valid internal token → OK", intOk.outcome === "OK");

  const intBad = await evaluateAccess({
    access: internal,
    session: null,
    internalToken: "wrong-token",
  });
  check("resolver: INTERNAL with wrong token → ACCESS_DENIED", intBad.outcome === "ACCESS_DENIED");

  const intNone = await evaluateAccess({ access: internal, session: null });
  check("resolver: INTERNAL without token → ACCESS_DENIED", intNone.outcome === "ACCESS_DENIED");

  const plain = await evaluateAccess({ access: pub, session: null });
  check("resolver: PUBLIC anonymous session → OK", plain.outcome === "OK");

  const capNo = await evaluateAccess({ access: pubCap, session: null, captchaToken: null });
  check("resolver: PUBLIC+captcha without token → CAPTCHA_REQUIRED", capNo.outcome === "CAPTCHA_REQUIRED");

  const capYes = await evaluateAccess({
    access: pubCap,
    session: null,
    captchaToken: CAPTCHA_TOKEN,
  });
  check(
    "resolver: PUBLIC+captcha with valid token → OK (verified)",
    capYes.outcome === "OK" && capYes.access.captcha.verified === true
  );

  const actorNoSession = await evaluateAccess({ access: actor, session: null });
  check(
    "resolver: ACTOR without session → AUTHENTICATION_REQUIRED (methods kept)",
    actorNoSession.outcome === "AUTHENTICATION_REQUIRED" &&
      JSON.stringify(actorNoSession.authentication.methods) === JSON.stringify(["AADHAAR"]) &&
      actorNoSession.node === undefined
  );
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
let serverChild = null;
let serverLog = "";

async function startServer() {
  serverChild = spawn(process.execPath, ["src/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverChild.stdout.on("data", (d) => {
    serverLog += d.toString();
  });
  serverChild.stderr.on("data", (d) => {
    serverLog += d.toString();
  });
  serverChild.on("exit", (code) => {
    serverLog += `\n[server exited with code ${code}]\n`;
  });

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
      if (resp.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`Server did not become healthy. Log:\n${serverLog}`);
}

function stopServer() {
  if (serverChild) serverChild.kill();
}

// ── DB seeding helper (drives the rule engine to a chosen latest event) ──────
async function seedWorkflowState(workflowId, stateKey, domainPatch = {}) {
  const { sql } = require(path.join(ROOT, "src", "config", "db"));
  const events = {
    states: [
      {
        eventType: "STATE_TRANSITION",
        workflowId,
        actor: "BORROWER",
        eventName: stateKey,
        metadata: {},
        timestamp: new Date().toISOString(),
      },
    ],
    currentState: stateKey,
  };
  await sql`
    UPDATE work_identifiers
    SET events = ${JSON.stringify(events)}, updated_at = NOW()
    WHERE workflow_id = ${workflowId}
  `;
  await sql`
    INSERT INTO domain_datastore (workflow_id, data)
    VALUES (${workflowId}, ${JSON.stringify(domainPatch)}::jsonb)
    ON CONFLICT (workflow_id)
    DO UPDATE SET data = domain_datastore.data || ${JSON.stringify(domainPatch)}::jsonb,
                  updated_at = NOW()
  `;
}

// ── Scenario 1/2/3/11/12: anonymous journey with public + captcha nodes ──────
async function runJourneyTests() {
  console.log("\n── Scenario 1/2/11/12: anonymous session, public nodes, events ───");
  const created = await api("POST", "/workflow/session", {});
  check("create session → 201", created.status === 201, created.body);
  check("session id format SES-*", /^SES-/.test(created.body?.sessionId ?? ""), created.body);
  check("session status ANONYMOUS", created.body?.status === "ANONYMOUS", created.body);
  check("session has workflowId", Boolean(created.body?.workflowId), created.body);
  check(
    "session expiresAt in the future",
    new Date(created.body?.expiresAt) > new Date(),
    created.body
  );

  const sessionId = created.body.sessionId;
  const workflowId = created.body.workflowId;

  const r1 = await api("POST", "/workflow/resolve", { sessionId });
  check("resolve → OK", r1.body?.status === "OK", r1.body);
  check("resolve → start node", r1.body?.node === START, r1.body);
  check("resolve → component", r1.body?.component === "PersonalInfoPage", r1.body);
  check("resolve → access PUBLIC", r1.body?.access?.type === "PUBLIC", r1.body);

  // Reload / repeat resolution returns the same authoritative node.
  const r2 = await api("POST", "/workflow/resolve", { sessionId });
  check("reload resolve → same node", r2.body?.node === r1.body?.node, r2.body);

  const gs = await api("GET", `/workflow/session/${sessionId}`);
  check("GET session → 200", gs.status === 200, gs.body);
  check("GET session status ANONYMOUS", gs.body?.status === "ANONYMOUS", gs.body);

  // Event 1: personal info → rule engine ED01 → address
  const ev1 = await api("POST", "/workflow/event", {
    sessionId,
    node: START,
    event: "PERSONAL_INFO_SUBMITTED",
    data: { fullName: "Test User", panNumber: "ABCDE1234F", basicInfoCompleted: true },
  });
  check("event 1 published", ev1.body?.success === true, ev1.body);
  check("event 1 → next node ADDRESS (rule engine)", ev1.body?.data?.nextState === ADDRESS, ev1.body);

  const r3 = await api("POST", "/workflow/resolve", { sessionId });
  check("resolve after event 1 → ADDRESS", r3.body?.node === ADDRESS && r3.body?.status === "OK", r3.body);

  // Event 2: address → rule engine ED02 → KYC upload
  const ev2 = await api("POST", "/workflow/event", {
    sessionId,
    node: ADDRESS,
    event: "ADDRESS_INFO_SUBMITTED",
    data: { pincode: "560001" },
  });
  check("event 2 published", ev2.body?.success === true, ev2.body);
  check("event 2 → next node KYC_UPLOAD", ev2.body?.data?.nextState === KYC_UPLOAD, ev2.body);
  return { sessionId, workflowId };
}

// ── Scenario 3: PUBLIC + CAPTCHA node ────────────────────────────────────────
async function runCaptchaTests(journey) {
  console.log("\n── Scenario 3: PUBLIC + CAPTCHA node ─────────────────────────────");
  const { sessionId } = journey;

  const noTok = await api("POST", "/workflow/resolve", { sessionId });
  check("captcha node resolve → CAPTCHA_REQUIRED", noTok.body?.status === "CAPTCHA_REQUIRED", noTok.body);
  check("captcha requirement flagged", noTok.body?.captcha?.required === true, noTok.body);
  check("captcha node + component returned", noTok.body?.node === KYC_UPLOAD && noTok.body?.component === "KYCUploadPage", noTok.body);

  const badTok = await api("POST", "/workflow/resolve", { sessionId, captchaToken: "wrong-token" });
  check("invalid captcha token → CAPTCHA_REQUIRED", badTok.body?.status === "CAPTCHA_REQUIRED", badTok.body);

  const goodTok = await api("POST", "/workflow/resolve", { sessionId, captchaToken: CAPTCHA_TOKEN });
  check("valid captcha token → OK", goodTok.body?.status === "OK", goodTok.body);
  check("captcha marked verified", goodTok.body?.access?.captcha?.verified === true, goodTok.body);

  // Event submission for a captcha node must verify the token server-side.
  const evNoCap = await api("POST", "/workflow/event", {
    sessionId,
    node: KYC_UPLOAD,
    event: "KYC_UPLOAD_SUBMITTED",
    data: {},
  });
  check("event without captcha → CAPTCHA_REQUIRED", evNoCap.body?.status === "CAPTCHA_REQUIRED", evNoCap.body);
  check("denied event did not publish", evNoCap.body?.success !== true, evNoCap.body);

  const evCap = await api("POST", "/workflow/event", {
    sessionId,
    node: KYC_UPLOAD,
    event: "KYC_UPLOAD_SUBMITTED",
    data: { aadharUploaded: true, panUploaded: true },
    captchaToken: CAPTCHA_TOKEN,
  });
  check("event with captcha → published", evCap.body?.success === true, evCap.body);
  check("event 3 → next node FACE (rule engine ED03)", evCap.body?.data?.nextState === FACE, evCap.body);

  const after = await api("POST", "/workflow/resolve", { sessionId });
  check("resolve after captcha node → FACE public node", after.body?.status === "OK" && after.body?.node === FACE, after.body);
  check("FACE node access PUBLIC", after.body?.access?.type === "PUBLIC", after.body);
}

// ── Scenarios 2/4/5: actor-protected node → AUTHENTICATION_REQUIRED ──────────
let actorSession = null; // shared with later scenario checks

async function runActorDeniedTests() {
  console.log("\n── Scenario 2/4/5: actor-protected node → AUTHENTICATION_REQUIRED ─");
  const created = await api("POST", "/workflow/session", {});
  const sessionId = created.body.sessionId;
  const workflowId = created.body.workflowId;

  // Drive the rule engine to the AADHAR node (latest event = PAN-VERIFICATION).
  await seedWorkflowState(workflowId, PAN_NODE, {
    KYC: { pan: { status: "VERIFIED", nameMatched: true } },
  });

  const denied = await api("POST", "/workflow/resolve", { sessionId });
  check("protected node → AUTHENTICATION_REQUIRED", denied.body?.status === "AUTHENTICATION_REQUIRED", denied.body);
  check(
    "acceptable methods listed",
    JSON.stringify(denied.body?.authentication?.methods) === JSON.stringify(["AADHAAR"]),
    denied.body
  );
  check(
    "protected node NOT returned",
    denied.body?.node === undefined && denied.body?.component === undefined,
    denied.body
  );

  const evDenied = await api("POST", "/workflow/event", {
    sessionId,
    node: AADHAR,
    event: "AADHAR_VERIFICATION_SUBMITTED",
    data: {},
  });
  check(
    "event on protected node without auth → AUTHENTICATION_REQUIRED",
    evDenied.body?.status === "AUTHENTICATION_REQUIRED",
    evDenied.body
  );
  check("denied event did not publish", evDenied.body?.success !== true, evDenied.body);

  actorSession = { sessionId, workflowId };
  return actorSession;
}

// ── Scenario 6/7/8: successful authentication + protected-node access ────────
async function runAuthenticationTests(actor) {
  const { sessionId } = actor;

  console.log("\n── Scenario 5b: authentication method must be acceptable ─────────");
  const chWrong = await api("POST", "/auth/challenge", {
    sessionId,
    method: "MOBILE_OTP",
    destination: "9876543210",
  });
  check(
    "MOBILE_OTP challenge issued",
    chWrong.body?.status === "OK" && Boolean(chWrong.body?.challengeId),
    chWrong.body
  );
  check("dev code only returned in dev mode", Boolean(chWrong.body?.devCode), chWrong.body);

  const wrongCode = chWrong.body?.devCode === "000000" ? "999999" : "000000";
  const badVerify = await api("POST", "/auth/verify", {
    sessionId,
    method: "MOBILE_OTP",
    credential: { challengeId: chWrong.body?.challengeId, code: wrongCode },
  });
  check("wrong OTP code rejected server-side", badVerify.body?.authenticated === false, badVerify.body);

  const vWrong = await api("POST", "/auth/verify", {
    sessionId,
    method: "MOBILE_OTP",
    credential: { challengeId: chWrong.body?.challengeId, code: chWrong.body?.devCode },
  });
  check("MOBILE_OTP verify success", vWrong.body?.authenticated === true, vWrong.body);
  check("verify returns actorId ACTOR-*", /^ACTOR-/.test(vWrong.body?.actorId ?? ""), vWrong.body);
  check("verify returns sessionId", vWrong.body?.sessionId === sessionId, vWrong.body);
  check(
    "verify returns authentication block",
    vWrong.body?.authentication?.method === "MOBILE_OTP",
    vWrong.body
  );

  const stillDenied = await api("POST", "/workflow/resolve", { sessionId });
  check(
    "wrong method still → AUTHENTICATION_REQUIRED",
    stillDenied.body?.status === "AUTHENTICATION_REQUIRED",
    stillDenied.body
  );

  console.log("\n── Scenario 6/7/8: AADHAAR authentication → protected node ───────");
  const ch = await api("POST", "/auth/challenge", {
    sessionId,
    method: "AADHAAR",
    destination: "234567890123",
  });
  check(
    "AADHAAR challenge issued",
    ch.body?.status === "OK" && Boolean(ch.body?.challengeId),
    ch.body
  );

  const verified = await api("POST", "/auth/verify", {
    sessionId,
    method: "AADHAAR",
    credential: { challengeId: ch.body?.challengeId, code: ch.body?.devCode },
  });
  check("AADHAAR verify → authenticated", verified.body?.authenticated === true, verified.body);
  check("actor session created (actorId)", /^ACTOR-/.test(verified.body?.actorId ?? ""), verified.body);
  check("session association returned", verified.body?.sessionId === sessionId, verified.body);
  check(
    "actor auth expiry set",
    new Date(verified.body?.authentication?.expiresAt) > new Date(),
    verified.body
  );
  actor.verifiedActorId = verified.body?.actorId;

  const allowed = await api("POST", "/workflow/resolve", { sessionId });
  check("protected node after auth → OK", allowed.body?.status === "OK", allowed.body);
  check("node is the AADHAR node", allowed.body?.node === AADHAR, allowed.body);
  check("access type ACTOR", allowed.body?.access?.type === "ACTOR", allowed.body);
  check(
    "authentication method accepted",
    allowed.body?.access?.authentication?.method === "AADHAAR",
    allowed.body
  );

  const gs = await api("GET", `/workflow/session/${sessionId}`);
  check("session status ACTOR_AUTHENTICATED", gs.body?.status === "ACTOR_AUTHENTICATED", gs.body);
  check("session carries actorId", gs.body?.actorId === actor.verifiedActorId, gs.body);
  check("session carries authentication block", gs.body?.authentication?.method === "AADHAAR", gs.body);
}

// ── Scenario 9: actor session expires, workflow journey stays valid ──────────
async function runExpiryTests(actor) {
  const { sessionId } = actor;

  console.log("\n── Scenario 9: actor session expiration ───────────────────────────");
  await sleep(6500); // ACTOR_SESSION_TTL_MINUTES = 0.1 → 6 seconds

  const reAuth = await api("POST", "/workflow/resolve", { sessionId });
  check(
    "actor session expired → AUTHENTICATION_REQUIRED",
    reAuth.body?.status === "AUTHENTICATION_REQUIRED",
    reAuth.body
  );
  check("workflow session NOT expired", reAuth.body?.status !== "SESSION_EXPIRED", reAuth.body);

  const gs = await api("GET", `/workflow/session/${sessionId}`);
  check("workflow session still valid (200)", gs.status === 200, gs.body);
  check("effective status back to ANONYMOUS", gs.body?.status === "ANONYMOUS", gs.body);
  check("expired authentication omitted", gs.body?.authentication === undefined, gs.body);

  // ── Scenario 14: latest-event / actor fallback ────────────────────────────
  console.log("\n── Scenario 14: latest-event / actor fallback behaviour ───────────");
  const fallback = await api("POST", "/workflow/resolve", { sessionId, workflowActor: "LENDER" });
  check("fallback → requesting actor's own node", fallback.body?.node === LENDER_ENTRY, fallback.body);
  check("fallback keeps NOT_YOUR_TURN status", fallback.body?.actorStatus === "NOT_YOUR_TURN", fallback.body);
  check("fallback does not expose protected node", fallback.body?.node !== AADHAR, fallback.body);
}

// ── Scenario 10: workflow session expiration ─────────────────────────────────
async function runSessionExpiryTests() {
  console.log("\n── Scenario 10: workflow session expiration ───────────────────────");
  const shortLived = await api("POST", "/workflow/session", { ttlMinutes: 0.05 });
  check("short-TTL session created", shortLived.status === 201, shortLived.body);

  await sleep(3600); // 0.05 minutes = 3 seconds

  const expired = await api("POST", "/workflow/resolve", {
    sessionId: shortLived.body.sessionId,
  });
  check("expired session → SESSION_EXPIRED", expired.body?.status === "SESSION_EXPIRED", expired.body);

  const expiredGet = await api("GET", `/workflow/session/${shortLived.body.sessionId}`);
  check("GET expired session → 404 SESSION_EXPIRED", expiredGet.status === 404 && expiredGet.body?.status === "SESSION_EXPIRED", expiredGet.body);

  const unknown = await api("POST", "/workflow/resolve", { sessionId: "SES-DOESNOTEXIST" });
  check("unknown session → SESSION_EXPIRED (single restart path)", unknown.body?.status === "SESSION_EXPIRED", unknown.body);

  const noSession = await api("POST", "/workflow/resolve", {});
  check("missing sessionId → ERROR", noSession.status === 400 && noSession.body?.status === "ERROR", noSession.body);
}

// ── Scenarios 12/13: terminal workflow + legacy endpoints unchanged ──────────
async function runTerminalAndLegacyTests(journey) {
  console.log("\n── Workflow completed + legacy endpoint compatibility ─────────────");
  const created = await api("POST", "/workflow/session", {});
  const terminalWorkflowId = created.body.workflowId;
  await seedWorkflowState(terminalWorkflowId, REJECTED, {});

  const done = await api("POST", "/workflow/resolve", { sessionId: created.body.sessionId });
  check("terminal node → WORKFLOW_COMPLETED", done.body?.status === "WORKFLOW_COMPLETED", done.body);
  check("terminal node reported", done.body?.node === REJECTED, done.body);

  // Legacy /decider WITHOUT session — untouched behaviour (rule engine path).
  const legacyDecider = await api("POST", "/workflow/decider", {
    WORKFLOW_ID: journey.workflowId,
    WORKFLOW_ACTOR: "BORROWER",
  });
  check("legacy decider → success payload", legacyDecider.body?.success === true, legacyDecider.body);
  check(
    "legacy decider → engine's resolved node",
    legacyDecider.body?.data?.componentviewrenderState === FACE,
    legacyDecider.body
  );
  check("legacy decider status ACTIVE", legacyDecider.body?.data?.status === "ACTIVE", legacyDecider.body);

  // /decider WITH session → new pipeline response.
  const sessionDecider = await api("POST", "/workflow/decider", { sessionId: journey.sessionId });
  check("session decider → pipeline status OK", sessionDecider.body?.status === "OK", sessionDecider.body);
  check("session decider → same node as /resolve", sessionDecider.body?.node === FACE, sessionDecider.body);

  // Legacy eventCreaterAndProcesser WITHOUT session — unchanged behaviour.
  const legacyRow = await api("POST", "/workflow/workidentifier", {
    workflow_id: `LEGACY-${Date.now()}`,
    events: {},
  });
  check("legacy work identifier created", legacyRow.status === 201, legacyRow.body);

  const legacyWorkflowId = legacyRow.body?.data?.workflow_id ?? legacyRow.body?.workflow_id;
  const legacyEvent = await api("POST", "/workflow/eventCreaterAndProcesser", {
    eventType: "PERSONAL_INFO_SUBMITTED",
    workflowMetadata: {
      workflowId: legacyWorkflowId,
      workflowActor: "BORROWER",
      componentViewRenderState: START,
    },
    formData: { fullName: "Legacy User" },
  });
  check("legacy event path → published + decided", legacyEvent.body?.success === true, legacyEvent.body);
  check("legacy event path → next node ADDRESS", legacyEvent.body?.data?.nextState === ADDRESS, legacyEvent.body);
}

// ── Runner ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== session + access-control + authentication test suite ===");

  await runUnitTests();

  console.log("\nStarting API server (test env)...");
  await startServer();
  console.log("API server healthy.");

  // Existing endpoint — event storage requires the domain datastore table.
  const tbl = await api("POST", "/workflow/createDomainDatastoreTable");
  check("domain datastore table ready", tbl.status === 201 || tbl.status === 200, tbl.body);

  const journey = await runJourneyTests();
  await runCaptchaTests(journey);

  const actor = await runActorDeniedTests();
  await runAuthenticationTests(actor);
  await runExpiryTests(actor);

  await runSessionExpiryTests();
  await runTerminalAndLegacyTests(journey);

  stopServer();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("Failed checks:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  stopServer();
  console.error("\nTest run crashed:", err);
  if (serverLog) console.error(`\n--- server log tail ---\n${serverLog.slice(-4000)}`);
  process.exit(1);
});







