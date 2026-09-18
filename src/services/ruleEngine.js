function getFieldValue(context, fieldPath) {
  return fieldPath.split(".").reduce((obj, key) => {
    if (obj == null) return undefined;
    return obj[key];
  }, context);
}

function evaluateCondition(context, condition) {
  let actual = getFieldValue(context, condition.field);
  const expected = condition.value;

  // Treat null and "" as the same empty value.
  const isNullOrEmpty = (v) => v === null || v === "";
  if (isNullOrEmpty(actual) && isNullOrEmpty(expected)) {
    console.log(`[ruleEngine] ${condition.field} (actual=${JSON.stringify(actual)}) ${condition.operator} ${JSON.stringify(expected)} → true (null/"" match)`);
    return condition.operator === "=" ? true : false;
  }

  let result;
  switch (condition.operator) {
    case "=":
      result = actual === expected;
      break;
    case "!=":
      result = actual !== expected;
      break;
    case ">":
      result = actual > expected;
      break;
    case "<":
      result = actual < expected;
      break;
    case ">=":
      result = actual >= expected;
      break;
    case "<=":
      result = actual <= expected;
      break;
    default:
      result = false;
  }

  console.log(`[ruleEngine] ${condition.field} (actual=${JSON.stringify(actual)}) ${condition.operator} ${JSON.stringify(expected)} → ${result}`);
  return result;
}

function evaluateRuleEngine(context, ruleEngine) {
  if (!ruleEngine || !ruleEngine.conditions?.length) {
    return true;
  }
  console.log("CONTECT" ,JSON.stringify(context,null,2))

  const results = ruleEngine.conditions.map((condition) =>
    evaluateCondition(context, condition)
  );

  if (ruleEngine.type === "OR") {
    return results.some(Boolean);
  }

  return results.every(Boolean);
}

module.exports = { getFieldValue, evaluateCondition, evaluateRuleEngine };
