/**
 * Minimal, explicit migration runner.
 *
 * - Every `.sql` file in `src/db/migrations` is one migration (version = file name).
 * - Applied versions and their checksums are recorded in `schema_migrations`.
 * - Each migration runs inside its own transaction.
 * - Changing an already-applied file is detected and refused.
 *
 * Commands: `up` (default), `down` (revert the latest), `status`.
 */
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { closePool, getPool } = require("./pool");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql")).sort();
}

function downFileName(version) {
  return version.replace(/\.sql$/, ".down.sql");
}

async function readSql(fileName) {
  return fs.readFile(path.join(MIGRATIONS_DIR, fileName), "utf8");
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  const result = await getPool().query(
    "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version"
  );
  return result.rows;
}

async function assertNoDrift(applied) {
  for (const row of applied) {
    let sql;
    try {
      sql = await readSql(row.version);
    } catch {
      throw new Error(`Applied migration '${row.version}' is missing from ${MIGRATIONS_DIR}`);
    }
    if (checksum(sql) !== row.checksum) {
      throw new Error(
        `Migration '${row.version}' was modified after it was applied. ` +
          "Create a new migration instead of editing an applied one."
      );
    }
  }
}

/** Applies every pending migration. Returns the list of applied versions. */
async function migrateUp() {
  const applied = await getAppliedMigrations();
  await assertNoDrift(applied);

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = (await listMigrationFiles()).filter((file) => !appliedVersions.has(file));

  const client = await getPool().connect();
  const justApplied = [];
  try {
    for (const file of pending) {
      const sql = await readSql(file);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [file, checksum(sql)]
        );
        await client.query("COMMIT");
        justApplied.push(file);
        console.log(`[migrate] applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration '${file}' failed: ${error.message}`);
      }
    }
  } finally {
    client.release();
  }

  if (justApplied.length === 0) console.log("[migrate] database is up to date");
  return justApplied;
}

/** Reverts the most recently applied migration. */
async function migrateDown() {
  const applied = await getAppliedMigrations();
  const latest = applied[applied.length - 1];
  if (!latest) {
    console.log("[migrate] nothing to revert");
    return null;
  }

  const file = downFileName(latest.version);
  const sql = await readSql(file);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [latest.version]);
    await client.query("COMMIT");
    console.log(`[migrate] reverted ${latest.version}`);
    return latest.version;
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`Rollback of '${latest.version}' failed: ${error.message}`);
  } finally {
    client.release();
  }
}

async function migrationStatus() {
  const applied = await getAppliedMigrations();
  const appliedVersions = new Set(applied.map((row) => row.version));
  const files = await listMigrationFiles();

  return {
    applied: applied.map((row) => ({ version: row.version, appliedAt: row.applied_at })),
    pending: files.filter((file) => !appliedVersions.has(file)),
  };
}

async function runCli(command = process.argv[2] || "up") {
  if (command === "up") {
    await migrateUp();
  } else if (command === "down") {
    await migrateDown();
  } else if (command === "status") {
    console.log(JSON.stringify(await migrationStatus(), null, 2));
  } else {
    throw new Error(`Unknown migration command '${command}'. Use up, down, or status.`);
  }
}

if (require.main === module) {
  runCli()
    .catch((error) => {
      console.error(`[migrate] failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await closePool();
      } catch (error) {
        console.error(`[migrate] failed to close database pool: ${error.message}`);
        process.exitCode = 1;
      }
    });
}

module.exports = { migrateUp, migrateDown, migrationStatus };
