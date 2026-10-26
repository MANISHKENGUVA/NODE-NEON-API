require("dotenv").config();
const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in environment variables");
}

const sql = neon(process.env.DATABASE_URL);

async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS workflow_identifiers (
      id SERIAL PRIMARY KEY,
      workflow_identifier VARCHAR(100) UNIQUE NOT NULL,
      workflow_id VARCHAR(100) NOT NULL,
      version INT DEFAULT 1,
      current_state VARCHAR(200) NOT NULL,
      status VARCHAR(50) DEFAULT 'IN_PROGRESS',
      context JSONB DEFAULT '{}'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS workflow_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_identifier VARCHAR(100),
      workflow_id VARCHAR(100),
      version INT,
      start_node VARCHAR(200),
      started_at TIMESTAMP,
      events_json JSONB,
      status VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  // Add column workflow_identifier if existing table doesn't have it
  await sql`
    ALTER TABLE workflow_events 
    ADD COLUMN IF NOT EXISTS workflow_identifier VARCHAR(100)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS work_identifiers (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id VARCHAR(255),
      events JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // ── Workflow session + actor authentication ────────────────────────────────
  // A workflow session starts ANONYMOUS and may later be associated with an
  // authenticated actor session. Both have independent expiries.
  await sql`
    CREATE TABLE IF NOT EXISTS workflow_sessions (
      session_id VARCHAR(64) PRIMARY KEY,
      workflow_id VARCHAR(255) NOT NULL,
      workflow_actor VARCHAR(100) DEFAULT 'BORROWER',
      status VARCHAR(40) DEFAULT 'ANONYMOUS',
      actor_id VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS actor_sessions (
      actor_session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id VARCHAR(64) NOT NULL,
      actor_id VARCHAR(100) NOT NULL,
      method VARCHAR(40) NOT NULL,
      subject_hash VARCHAR(128),
      verified_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_actor_sessions_session_id
    ON actor_sessions (session_id)
  `;

  // Server-issued authentication challenges (OTP style verification).
  // Only a hash of the code is stored — the code itself never hits the DB.
  await sql`
    CREATE TABLE IF NOT EXISTS auth_challenges (
      challenge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id VARCHAR(64),
      method VARCHAR(40) NOT NULL,
      subject_hash VARCHAR(128),
      code_hash VARCHAR(128) NOT NULL,
      attempts INT DEFAULT 0,
      max_attempts INT DEFAULT 5,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
}

async function createWorkIdentifierTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS work_identifiers (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id VARCHAR(255),
      events JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return { success: true, message: "Table work_identifiers created successfully" };
}

module.exports = { sql, initDb, createWorkIdentifierTable };
