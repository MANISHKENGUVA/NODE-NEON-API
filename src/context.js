const { AsyncLocalStorage } = require("async_hooks");
const { randomUUID } = require("crypto");

/**
 * AsyncLocalStorage instance for request-scoped context tracking.
 */
const context = new AsyncLocalStorage();



/**
 * Convenience function to get a specific value from active context.
 * @param {string} key 
 */
function getContextKey(key) {
  const store = context.getStore();
  return store ? store[key] : undefined;
}

/**
 * Convenience function to update or set a value in active context.
 * @param {string} key 
 * @param {any} value 
 */
function setContextKey(key, value) {
  const store = context.getStore();
  if (store) {
    store[key] = value;
  }
}

module.exports = {
  context,
  getContextKey,
  setContextKey,
};
