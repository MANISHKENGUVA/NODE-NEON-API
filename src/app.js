/**
 * Express application assembly.
 *
 * Order matters:
 *   request log → API docs → security headers/body parsing → routes →
 *   404 → error handler
 */
const express = require("express");
const { applySecurity } = require("./middleware/security");
const { requestLogger } = require("./middleware/requestLogger");
const { notFoundHandler, errorHandler } = require("./core/errors");
const docs = require("./openapi");
const routes = require("./routes");
const compatRoutes = require("./compat/routes");

function createApp() {
  const app = express();

  // Required for req.ip to be the client address behind a proxy (rate limits,
  // captcha remoteip, consent records).
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestLogger);
  app.use("/api-docs", docs);
  applySecurity(app);
  app.use("/api", routes);
  // Browser frontend contract (`/workflow/*`). Translates onto the same
  // services; see src/compat/routes.js.
  app.use(compatRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
