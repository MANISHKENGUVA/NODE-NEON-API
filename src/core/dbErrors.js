/**
 * Translates PostgreSQL constraint violations into API errors.
 *
 * Without this, a duplicate key or a CHECK failure escapes as a 500 and the
 * client cannot tell what to fix. Anything unrecognised is rethrown so the
 * generic 500 handler still hides internals.
 */
const { AppError, conflict, unprocessable } = require("./errors");

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";

/** Turns a driver error into an AppError, or returns it unchanged. */
function translateDbError(error) {
  if (error instanceof AppError) return error;

  switch (error?.code) {
    case UNIQUE_VIOLATION:
      return conflict("DUPLICATE_RECORD", "That record already exists");
    case FOREIGN_KEY_VIOLATION:
      return unprocessable("INVALID_REFERENCE", "Related record does not exist");
    case CHECK_VIOLATION:
    case NOT_NULL_VIOLATION:
      return unprocessable(
        "CONSTRAINT_VIOLATION",
        "A submitted value is outside the allowed range"
      );
    default:
      return error;
  }
}

/** Rethrows `error` as an API error when it is a known constraint failure. */
function rethrowDbError(error) {
  const translated = translateDbError(error);
  if (translated === error) throw error;
  throw translated;
}

module.exports = { translateDbError, rethrowDbError };
