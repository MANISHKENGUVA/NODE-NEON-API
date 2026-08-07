function getFieldValue(context, fieldPath) {
  return fieldPath.split(".").reduce((obj, key) => {
    if (obj == null) return undefined;
    return obj[key];
  }, context);
}

function evaluateCondition(context, condition) {
  const actual = getFieldValue(context, condition.field);
  const expected = condition.value;

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

function evaluateRuleEngine(context, ruleEngine) {
  if (!ruleEngine || !ruleEngine.conditions?.length) {
    return true;
  }

  const results = ruleEngine.conditions.map((condition) =>
    evaluateCondition(context, condition)
  );

  if (ruleEngine.type === "OR") {
    return results.some(Boolean);
  }

  return results.every(Boolean);
}

module.exports = { getFieldValue, evaluateCondition, evaluateRuleEngine };
