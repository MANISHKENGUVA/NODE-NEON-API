/**
 * Flow definition access.
 *
 * `FLOWDESINGER.json` is the single source of truth for states, edges, actors
 * and node access. It is validated once at startup so a malformed definition
 * fails the boot instead of surfacing as a broken transition at runtime.
 */
const raw = require("../FLOWDESIGNER/FLOWDESINGER.json");

class DefinitionError extends Error {}

function validateDefinition(definition) {
  const problems = [];

  if (!definition || typeof definition !== "object") {
    throw new DefinitionError("Flow definition must be an object");
  }
  if (!definition.workflowVersion) problems.push("workflowVersion is missing");
  if (!definition.states || typeof definition.states !== "object") {
    throw new DefinitionError("Flow definition must contain a 'states' object");
  }
  if (!definition.states[definition.startState]) {
    problems.push(`startState '${definition.startState}' does not exist in states`);
  }

  for (const [nodeKey, state] of Object.entries(definition.states)) {
    if (!state.metadata?.actor) problems.push(`state '${nodeKey}' has no metadata.actor`);

    for (const [edgeId, edge] of Object.entries(state.edges ?? {})) {
      if (!edge.toState) problems.push(`edge '${edgeId}' on '${nodeKey}' has no toState`);
      else if (!definition.states[edge.toState]) {
        problems.push(`edge '${edgeId}' on '${nodeKey}' points to unknown state '${edge.toState}'`);
      }
      if (!edge.ruleEngine?.conditions) {
        problems.push(`edge '${edgeId}' on '${nodeKey}' has no ruleEngine.conditions`);
      }
    }
  }

  if (problems.length > 0) {
    throw new DefinitionError(`Invalid flow definition:\n- ${problems.join("\n- ")}`);
  }

  return definition;
}

const definition = validateDefinition(raw);

function getState(nodeKey) {
  return definition.states[nodeKey] ?? null;
}

function isKnownNode(nodeKey) {
  return Boolean(nodeKey) && Object.prototype.hasOwnProperty.call(definition.states, nodeKey);
}

function getActorForNode(nodeKey) {
  return getState(nodeKey)?.metadata?.actor ?? null;
}

/** First node in definition order that belongs to `actor` — their entry point. */
function getEntryNodeForActor(actor) {
  for (const [nodeKey, state] of Object.entries(definition.states)) {
    if (state.metadata?.actor === actor) return nodeKey;
  }
  return null;
}

function isTerminal(nodeKey) {
  return getState(nodeKey)?.type === "TERMINAL";
}

function isSystemNode(nodeKey) {
  return getState(nodeKey)?.type === "SYSTEM";
}

function getComponent(nodeKey) {
  return getState(nodeKey)?.component ?? null;
}

function listActors() {
  return [...new Set(Object.values(definition.states).map((state) => state.metadata.actor))].sort();
}

module.exports = {
  definition,
  definitionVersion: definition.workflowVersion,
  startState: definition.startState,
  getState,
  isKnownNode,
  getActorForNode,
  getEntryNodeForActor,
  isTerminal,
  isSystemNode,
  getComponent,
  listActors,
  validateDefinition,
};
