/**
 * Process entry point.
 *
 * Boot order is deliberate:
 *   1. validate configuration (fail before touching the database)
 *   2. validate the step registry against the flow definition (fail before
 *      serving traffic with a node that has no handler)
 *   3. optionally apply migrations
 *   4. confirm the database answers
 *   5. listen
 *
 * Nothing is logged that could contain a secret or personal data.
 */
const { config, validateConfig } = require("./config/env");
const { ping, closePool } = require("./db/pool");
const { migrateUp } = require("./db/migrate");
const { assertRegistryComplete } = require("./workflow/stepRegistry");
const { definition } = require("./workflow/definition");
const app = require("./app");

async function start() {
  validateConfig();
  assertRegistryComplete();

  if (config.migrations.runOnBoot) {
    await migrateUp();
  }

  const databaseOk = await ping();
  if (!databaseOk) {
    throw new Error("Database did not answer the startup probe");
  }

  const server = app.listen(config.port, () => {
    console.log(
      `[start] ${definition.workflowVersion} listening on :${config.port} ` +
        `(${config.nodeEnv}) docs: /api-docs`
    );
  });

  const shutdown = (signal) => {
    console.log(`[stop] ${signal} received, shutting down`);
    server.close(() => {
      closePool()
        .catch((error) => console.error("[stop] pool close failed:", error.message))
        .finally(() => process.exit(0));
    });
    // Do not wait forever for keep-alive connections.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch(async (error) => {
  const detail =
    error instanceof Error
      ? error.message || `${error.name}${error.code ? ` (code: ${error.code})` : ""}`
      : String(error);
  console.error(`[start] failed: ${detail || "unknown startup error"}`);
  await closePool().catch(() => {});
  process.exit(1);
});
