/**
 * Node access policy.
 *
 * The flow definition may declare an `access` block per node:
 *
 *   { "type": "PUBLIC" }
 *   { "type": "PUBLIC", "captcha": { "required": true } }
 *   { "type": "ACTOR", "authentication": { "required": true, "methods": ["AADHAAR"] } }
 *   { "type": "INTERNAL" }
 *
 * Defaults:
 *   - a node without an access block is PUBLIC, except…
 *   - a SYSTEM node, which is INTERNAL: system steps (PAN/Aadhaar/face/bank/
 *     credit checks) are completed by trusted services, never by a browser.
 *
 * `access.type: ACTOR` always requires an authentication proof, even when the
 * block does not spell it out — an actor step means "this verified person is
 * acting", and `GET /workflow/state` reports it as `requiresAuthentication`,
 * so a client can see the requirement before it runs into a 403.
 *
 * This module only reads configuration. Whether a session satisfies it is
 * decided in `workflowService.submitStep` (`sessionService.assertActor` /
 * `assertAuthentication`).
 */
const { getState, isSystemNode } = require("./definition");

const ACCESS_TYPES = Object.freeze({
  PUBLIC: "PUBLIC",
  ACTOR: "ACTOR",
  INTERNAL: "INTERNAL",
});

const KNOWN_METHODS = Object.freeze(["MOBILE_OTP", "AADHAAR", "IDENTITY", "DOCUMENT"]);

function normalizeAccess(rawAccess, nodeKey = "") {
  const defaultType = isSystemNode(nodeKey) ? ACCESS_TYPES.INTERNAL : ACCESS_TYPES.PUBLIC;

  const defaults = {
    type: defaultType,
    captcha: { required: false },
    authentication: { required: false, methods: null },
  };

  if (!rawAccess || typeof rawAccess !== "object") return defaults;

  const requestedType =
    typeof rawAccess.type === "string" ? rawAccess.type.toUpperCase() : defaultType;
  const type = Object.prototype.hasOwnProperty.call(ACCESS_TYPES, requestedType)
    ? requestedType
    : defaultType;

  const methods =
    Array.isArray(rawAccess.authentication?.methods) && rawAccess.authentication.methods.length > 0
      ? rawAccess.authentication.methods.map((method) => String(method).toUpperCase())
      : null;

  return {
    type,
    captcha: { required: rawAccess.captcha?.required === true },
    authentication: {
      required: type === ACCESS_TYPES.ACTOR || rawAccess.authentication?.required === true,
      methods,
    },
  };
}

/** Normalized access configuration for a node (PUBLIC defaults for unknown nodes). */
function getNodeAccess(nodeKey) {
  const state = getState(nodeKey);
  if (!state) return { type: ACCESS_TYPES.PUBLIC, captcha: { required: false }, authentication: { required: false, methods: null } };
  return normalizeAccess(state.access, nodeKey);
}

module.exports = { ACCESS_TYPES, KNOWN_METHODS, normalizeAccess, getNodeAccess };
