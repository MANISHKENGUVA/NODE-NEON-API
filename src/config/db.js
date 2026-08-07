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
