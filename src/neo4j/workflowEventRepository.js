const neo4j = require("neo4j-driver");
const { config } = require("../config/env");

let driver = null;

function getDriver() {
  if (!config.neo4j.enabled) return null;

  if (!driver) {
    driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.username, config.neo4j.password),
      { disableLosslessIntegers: true }
    );
  }

  return driver;
}

async function closeDriver() {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

async function ping() {
  const currentDriver = getDriver();
  if (!currentDriver) return false;

  const session = currentDriver.session();
  try {
    const result = await session.run("RETURN 1 AS ok");
    return result.records[0]?.get("ok") === 1;
  } finally {
    await session.close();
  }
}

module.exports = { getDriver, closeDriver, ping };
