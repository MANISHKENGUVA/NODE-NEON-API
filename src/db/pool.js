/**
 * Database access.
 *
 * A single Neon connection pool is shared by the whole process. Queries are
 * always parameterised (`$1`, `$2`, …); user input is never concatenated into
 * SQL text.
 */
const { Pool } = require("@neondatabase/serverless");
const { config } = require("../config/env");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.db.url,
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (error) => {
      // A broken idle connection must never take the process down.
      console.error("[db] idle client error:", error.message);
    });
  }
  return pool;
}

/** Runs a parameterised query against the shared pool. */
function query(text, params = []) {
  return getPool().query(text, params);
}

/** Runs a query on an explicit executor (pool or transaction client). */
function run(executor, text, params = []) {
  return executor.query(text, params);
}

/**
 * Runs `work` inside a single transaction.
 *
 * `work` receives a dedicated client; every repository call inside it must use
 * that client so reads and writes see the same snapshot.
 */
async function withTransaction(work) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one that matters */
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ping() {
  const result = await query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, run, withTransaction, ping, closePool };
