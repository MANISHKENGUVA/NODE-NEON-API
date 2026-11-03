/**
 * Rule engine — evaluates the conditions on a flow edge.
 *
 * Pure functions only: no database, no logging of context, no access rules.
 * The caller supplies the workflow context (see `contextBuilder.js`).
 */

/** Reads `a.b.c` from a nested object; returns undefined for any gap. */
function getFieldValue(context, fieldPath) {
  if (!context || typeof fieldPath !== "string") return undefined;
  return fieldPath.split(".").reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, context);
}

const isEmptyValue = (value) => value === null || value === "" || value === undefined;

function evaluateCondition(context, condition) {
  const actual = getFieldValue(context, condition.field);
  const expected = condition.value;

  // Historic compatibility: a missing value and an empty string compare equal.
  if (isEmptyValue(actual) && isEmptyValue(expected)) {
    return condition.operator === "=";
  }

  switch (condition.operator) {
    case "=":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case ">":
      return actual > expected;
    case "<":
      return actual < expected;
    case ">=":
      return actual >= expected;
    case "<=":
      return actual <= expected;
    default:
      return false;
  }
}

/** An edge without conditions always matches. `type` is AND (default) or OR. */
function evaluateRuleEngine(context, ruleEngine) {
  const conditions = ruleEngine?.conditions ?? [];
  if (conditions.length === 0) return true;

  const results = conditions.map((condition) => evaluateCondition(context, condition));
  return String(ruleEngine.type ?? "AND").toUpperCase() === "OR"
    ? results.some(Boolean)
    : results.every(Boolean);
}

/**
 * First edge (in definition order) whose rule passes.
 * @returns {{edgeId: string, toState: string} | null}
 */
function firstMatchingEdge(state, context) {
  for (const [edgeId, edge] of Object.entries(state?.edges ?? {})) {
    if (evaluateRuleEngine(context, edge.ruleEngine)) {
      return { edgeId, toState: edge.toState };
    }
  }
  return null;
}

module.exports = { getFieldValue, evaluateCondition, evaluateRuleEngine, firstMatchingEdge };
