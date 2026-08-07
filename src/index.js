require("dotenv").config();
const express = require("express");
const { applyMiddleware } = require("./middleware");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const routes = require("./routes");
const { initDb } = require("./config/db");

const app = express();
const PORT = process.env.PORT || 3000;

applyMiddleware(app);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Node.js API with Neon PostgreSQL",
    endpoints: {
      createWorkflowIdentifier: "POST /api/workflow/identifier",
      // listWorkflowIdentifiers: "GET /api/workflow/identifiers",
      // getWorkflowIdentifier: "GET /api/workflow/identifier/:identifier",
      // updateWorkflowIdentifier: "PATCH /api/workflow/identifier/:identifier",
      // workflowRecorderDecider: "POST /api/workflow/recorder-decider",
      // appendWorkflowEvent: "POST /api/workflow/recorder/:id/events",
      createWorkIdentifierRecordTable: "POST /api/workflow/createdb",
      workflowEventCreaterAndProcesser:"POST /api/workflow/eventCreaterAndProcesser",
      workflowDecider: "POST /api/workflow/decider",
      workflowNavigator: "POST /api/workflow/navigator",
    },
  });
});

app.use("/api", routes);
app.use(notFound);
app.use(errorHandler);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
