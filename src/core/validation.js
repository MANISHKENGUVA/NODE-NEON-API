/**
 * Input validation helpers.
 *
 * Explicit checks at the API boundary beat a schema DSL here: every rule is
 * readable at the call site and throws a `VALIDATION_FAILED` AppError.
 */
const { validationFailed } = require("./errors");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE = /^[1-9][0-9]{5}$/;
const MOBILE = /^[6-9][0-9]{9}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

function requireObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw validationFailed(`'${field}' must be an object`);
  }
  return value;
}

function optionalObject(value, field) {
  if (value === undefined || value === null) return {};
  return requireObject(value, field);
}

function requireString(value, field, { max = 500, min = 1 } = {}) {
  if (typeof value !== "string") throw validationFailed(`'${field}' must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw validationFailed(`'${field}' is required`);
  if (trimmed.length > max) throw validationFailed(`'${field}' must be at most ${max} characters`);
  return trimmed;
}

function optionalString(value, field, options) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, options);
}

function requireNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw validationFailed(`'${field}' must be a number`);
  }
  if (parsed < min || parsed > max) {
    throw validationFailed(`'${field}' must be between ${min} and ${max}`);
  }
  return parsed;
}

function optionalNumber(value, field, options) {
  if (value === undefined || value === null || value === "") return null;
  return requireNumber(value, field, options);
}

function requireBoolean(value, field) {
  if (typeof value !== "boolean") throw validationFailed(`'${field}' must be a boolean`);
  return value;
}

function requireEnum(value, field, allowed) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : value;
  if (!allowed.includes(normalized)) {
    throw validationFailed(`'${field}' must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}

function optionalEnum(value, field, allowed) {
  if (value === undefined || value === null || value === "") return null;
  return requireEnum(value, field, allowed);
}

function requireMatch(value, field, pattern, message) {
  const text = requireString(value, field);
  const candidate = pattern === PAN || pattern === IFSC ? text.toUpperCase() : text;
  if (!pattern.test(candidate)) throw validationFailed(message ?? `'${field}' has an invalid format`);
  return candidate;
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const text = requireString(value, field);
  if (!ISO_DATE.test(text) || Number.isNaN(new Date(text).getTime())) {
    throw validationFailed(`'${field}' must be an ISO date (YYYY-MM-DD)`);
  }
  return text;
}

function requireDate(value, field) {
  const parsed = optionalDate(value, field);
  if (!parsed) throw validationFailed(`'${field}' is required`);
  return parsed;
}

module.exports = {
  patterns: { ISO_DATE, PAN, IFSC, PINCODE, MOBILE, EMAIL },
  requireObject,
  optionalObject,
  requireString,
  optionalString,
  requireNumber,
  optionalNumber,
  requireBoolean,
  requireEnum,
  optionalEnum,
  requireMatch,
  requireDate,
  optionalDate,
};
