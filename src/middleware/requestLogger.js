/**
 * Request logging and request correlation.
 *
 * Only method, path, status and duration are logged. Bodies, query strings,
 * tokens and personal data never reach the log.
 */
const crypto = require("crypto");

function requestLogger(req, res, next) {
  const requestId = req.get("x-request-id") ?? crypto.randomUUID();
  req.requestId = requestId;
  res.set("x-request-id", requestId);

  if (req.path === "/api/health") return next(); // keep health checks quiet

  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `[http] ${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms id=${requestId}`
    );
  });

  return next();
}

module.exports = { requestLogger };
