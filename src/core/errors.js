/**
 * Application error type and the two terminal Express handlers.
 *
 * Every expected failure is an `AppError` with a stable `code` that the client
 * can branch on. Unexpected failures become a generic 500 — driver messages,
 * SQL and stack traces never reach the client.
 */

class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expected = true;
  }
}

const badRequest = (message, details) => new AppError(400, "BAD_REQUEST", message, details);
const validationFailed = (message, details) =>
  new AppError(422, "VALIDATION_FAILED", message, details);
const unauthorized = (message) => new AppError(401, "UNAUTHORIZED", message);
// A session is a distinct credential from an API key, so its failures get
// their own codes: the client reacts differently to "expired, renew me" and
// "invalid, start recovery".
const sessionInvalid = (message) => new AppError(401, "SESSION_INVALID", message);
const sessionExpired = (message) => new AppError(401, "SESSION_EXPIRED", message);
const sessionRevoked = (message) => new AppError(401, "SESSION_REVOKED", message);
const captchaRequired = (message) => new AppError(400, "CAPTCHA_REQUIRED", message);
const captchaInvalid = (message) => new AppError(400, "CAPTCHA_INVALID", message);
const forbidden = (message) => new AppError(403, "FORBIDDEN", message);
const notFound = (message) => new AppError(404, "NOT_FOUND", message);
const conflict = (code, message, details) => new AppError(409, code, message, details);
const unprocessable = (code, message, details) => new AppError(422, code, message, details);
const tooManyRequests = (message) => new AppError(429, "RATE_LIMITED", message);
const serviceUnavailable = (message) => new AppError(503, "SERVICE_UNAVAILABLE", message);

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    status: "ERROR",
    code: "ROUTE_NOT_FOUND",
    message: `No route for ${req.method} ${req.path}`,
  });
}

/**
 * `body-parser` rejects a bad request before any route runs. Those are client
 * errors — a malformed body is a 400, not an internal failure — so they are
 * translated here instead of surfacing as a 500 with a stack trace.
 */
const BODY_PARSER_ERRORS = Object.freeze({
  "entity.parse.failed": [400, "INVALID_BODY", "Request body is not valid JSON"],
  "entity.too.large": [413, "PAYLOAD_TOO_LARGE", "Request body is too large"],
  "encoding.unsupported": [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content encoding"],
  "charset.unsupported": [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported charset"],
});

function translateClientError(error) {
  const mapped = BODY_PARSER_ERRORS[error?.type];
  return mapped ? new AppError(...mapped) : null;
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const failure = translateClientError(error) ?? error;
  const isExpected = failure instanceof AppError;
  const statusCode = isExpected ? failure.statusCode : 500;

  if (isExpected) {
    console.warn(
      `[error] ${req.method} ${req.path} -> ${statusCode} ${failure.code}: ${failure.message}`
    );
  } else {
    // Server-side detail only. The client gets a generic message.
    console.error(`[error] ${req.method} ${req.path} -> 500`, error);
  }

  res.status(statusCode).json({
    success: false,
    status: "ERROR",
    code: isExpected ? failure.code : "INTERNAL_ERROR",
    message: isExpected ? failure.message : "Internal server error",
    ...(isExpected && failure.details ? { details: failure.details } : {}),
  });
}

module.exports = {
  AppError,
  badRequest,
  validationFailed,
  unauthorized,
  sessionInvalid,
  sessionExpired,
  sessionRevoked,
  captchaRequired,
  captchaInvalid,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  serviceUnavailable,
  notFoundHandler,
  errorHandler,
};
