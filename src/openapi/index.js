/**
 * Swagger UI at `/api-docs` and the raw document at `/api-docs/openapi.json`.
 *
 * Mounted before `helmet()`: the Swagger UI bundle is inline JavaScript, which
 * the default Content-Security-Policy would block. Everything else in the app
 * still gets the full header set.
 */
const express = require("express");
const swaggerUi = require("swagger-ui-express");
const document = require("./document");

const router = express.Router();

router.get("/openapi.json", (req, res) => res.json(document));

router.use(
  "/",
  swaggerUi.serve,
  swaggerUi.setup(document, {
    customSiteTitle: "Loan Workflow API",
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  })
);

module.exports = router;
