const { AppError } = require("./errors");

const KEY_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

function requireIdempotencyKey(req) {
  const key = req.get("Idempotency-Key");
  if (!key) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required for this request"
    );
  }
  return validateIdempotencyKey(key);
}

function requireEventId(req, bodyEventId) {
  const eventId = bodyEventId ?? req.get("Idempotency-Key");
  if (!eventId) {
    throw new AppError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "An eventId or Idempotency-Key header is required for workflow writes"
    );
  }
  return validateIdempotencyKey(eventId);
}

function validateIdempotencyKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency keys must be 16 to 128 URL-safe characters"
    );
  }
  return key;
}

module.exports = { requireIdempotencyKey, requireEventId };
