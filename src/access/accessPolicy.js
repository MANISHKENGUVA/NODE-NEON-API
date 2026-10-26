/**
 * accessPolicy.js
 *
 * Pure node access configuration reader.
 *
 * Nodes may declare an optional `access` block in FLOWDESINGER.json:
 *
 *   { "node": "...", "access": { "type": "PUBLIC" } }
 *   { "node": "...", "access": { "type": "PUBLIC", "captcha": { "required": true } } }
 *   { "node": "...", "access": { "type": "ACTOR",
 *       "authentication": { "required": true, "methods": ["AADHAAR"] } } }
 *   { "node": "...", "access": { "type": "INTERNAL" } }
 *
 * Nodes WITHOUT an access block default to PUBLIC — this keeps every existing
 * node working exactly as before (backward compatibility).
 *
 * This module answers configuration only. Whether a given session satisfies
 * the configuration is decided by accessResolver.js. The Rule Engine never
 * sees access requirements.
 */

const workflowDefinition = require("../FLOWDESIGNER/FLOWDESINGER.json");

const ACCESS_TYPES = Object.freeze({
  PUBLIC: "PUBLIC",
  ACTOR: "ACTOR",
  INTERNAL: "INTERNAL",
});

/**
 * Normalizes a raw `access` block into a stable shape.
 *
 * @param   {object|null} rawAccess
 * @param   {string} [contextLabel] — node key, used for warnings only
 * @returns {{type: string, captcha: object, authentication: object}}
 */
function normalizeAccess(rawAccess, contextLabel = "") {
  const defaults = {
    type: ACCESS_TYPES.PUBLIC,
    captcha: { required: false },
    authentication: { required: false, methods: null },
  };

  if (!rawAccess || typeof rawAccess !== "object") {
    return defaults;
  }

  let type =
    typeof rawAccess.type === "string"
      ? rawAccess.type.toUpperCase()
      : ACCESS_TYPES.PUBLIC;

  if (!Object.prototype.hasOwnProperty.call(ACCESS_TYPES, type)) {
    console.warn(
      `[accessPolicy] Unknown access type '${rawAccess.type}' for node '${contextLabel}' → defaulting to PUBLIC`
    );
    type = ACCESS_TYPES.PUBLIC;
  }

  const captchaRequired = rawAccess.captcha?.required === true;

  const rawMethods = rawAccess.authentication?.methods;
  const methods =
    Array.isArray(rawMethods) && rawMethods.length > 0
      ? rawMethods.map((m) => String(m).toUpperCase())
      : null;

  const authenticationRequired =
    type === ACCESS_TYPES.ACTOR || rawAccess.authentication?.required === true;

  return {
    type,
    captcha: { required: captchaRequired },
    authentication: { required: authenticationRequired, methods },
  };
}

/**
 * Reads + normalizes the access configuration of a flow-definition node.
 *
 * @param   {string} nodeKey — e.g. "BORROWER-KYC-V1-AADHAR-VERIFICATION-V1"
 * @returns {{type: string, captcha: object, authentication: object}}
 */
function getNodeAccess(nodeKey) {
  const stateDef = workflowDefinition.states?.[nodeKey];
  if (!stateDef) {
    // Unknown node — callers must validate node keys before relying on this.
    return normalizeAccess(null, nodeKey);
  }
  return normalizeAccess(stateDef.access, nodeKey);
}

module.exports = {
  ACCESS_TYPES,
  normalizeAccess,
  getNodeAccess,
};
