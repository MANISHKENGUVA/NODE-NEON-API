/**
 * Rejects malformed UUID path parameters before they reach SQL.
 *
 * A malformed id answers 404 rather than 422 so the endpoint does not confirm
 * or deny anything about other identifiers.
 */
const { notFound } = require("../core/errors");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidParam(name) {
  return function validateParam(req, res, next) {
    if (!UUID.test(String(req.params[name] ?? ""))) {
      return next(notFound("Application not found"));
    }
    return next();
  };
}

module.exports = { requireUuidParam, UUID };
