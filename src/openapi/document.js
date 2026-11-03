/**
 * OpenAPI 3.1 description of the API.
 *
 * Kept as a plain object so `scripts/validate-openapi.js` can check it in CI and
 * so the Swagger UI route has no build step. `x-node-schemas` maps every step
 * node to the payload schema the handler expects — the tests assert that the
 * map covers exactly the nodes that exist in the flow definition.
 */
const { definition } = require("../workflow/definition");

const errorResponse = {
  description: "Error",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/ErrorEnvelope" },
    },
  },
};

function ok(schemaRef, description) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["success", "status", "data"],
          properties: {
            success: { type: "boolean", const: true },
            status: { type: "string", const: "OK" },
            data: { $ref: `#/components/schemas/${schemaRef}` },
          },
        },
      },
    },
  };
}

const bearerSession = [{ workflowSession: [] }];
const adminKey = [{ adminKey: [] }];
const internalToken = [{ internalToken: [] }];

const document = {
  openapi: "3.1.0",
  info: {
    title: "Loan Application Workflow API",
    version: definition.workflowVersion,
    description: [
      "Server-authoritative loan origination workflow.",
      "",
      "**Who is calling:** the actor is taken from the `x-workflow-session` header, never from the body.",
      "The borrower gets a session when the application is created, a co-borrower can request one once the",
      "flow reaches their stage, and LENDER/MANAGER sessions require `x-api-key`.",
      "",
      "**System steps:** steps whose node is a verification (face, PAN, Aadhaar, bank penny-drop, bureau,",
      "fraud, document, risk, eligibility, disbursement confirmation) can only be completed by a trusted",
      "service through the internal endpoint with `x-internal-token`.",
      "",
      "**reCAPTCHA v2:** `POST /applications` always requires `captchaToken`; a node whose access block",
      "declares `captcha.required` needs it as well. Set `RECAPTCHA_DEV_BYPASS=true` outside production",
      "to skip verification while developing.",
      "",
      "**Errors:** every failure is `{ success: false, status: \"ERROR\", code, message }`.",
    ].join("\n"),
  },
  servers: [{ url: "/api", description: "This deployment" }],
  tags: [
    { name: "Health" },
    { name: "Applications" },
    { name: "Workflow" },
    { name: "Sessions" },
    { name: "Authentication" },
    { name: "Recovery" },
    { name: "Internal" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness and database check",
        operationId: "getHealth",
        responses: {
          200: ok("Health", "Service and database are up"),
          503: ok("Health", "Database unreachable"),
        },
      },
    },

    "/captcha/config": {
      get: {
        tags: ["Health"],
        summary: "reCAPTCHA settings for the widget",
        description:
          "Returns the public site key and version. The secret key is never exposed. " +
          "`bypassed` is true when `RECAPTCHA_DEV_BYPASS` is on outside production.",
        operationId: "getCaptchaConfig",
        responses: {
          200: ok("CaptchaConfig", "Public reCAPTCHA settings"),
        },
      },
    },

    "/applications": {
      post: {
        tags: ["Applications"],
        summary: "Create an application",
        description:
          "Creates the application and BORROWER session once per Idempotency-Key. " +
          "Replays return the original application/session; a fresh recovery cookie is issued. " +
          "Requires a reCAPTCHA v2 token on the first request.",
        operationId: "createApplication",
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  captchaToken: { type: "string", description: "reCAPTCHA v2 response token" },
                },
              },
            },
          },
        },
        responses: {
          201: ok("CreatedApplication", "Application and session created"),
          200: ok("CreatedApplication", "Original application and session returned for this key"),
          400: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
      get: {
        tags: ["Applications"],
        summary: "List applications",
        operationId: "listApplications",
        security: adminKey,
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["IN_PROGRESS", "APPROVED", "REJECTED", "CANCELLED"] },
          },
        ],
        responses: { 200: ok("ApplicationList", "Page of applications"), 401: errorResponse },
      },
    },

    "/applications/{applicationId}": {
      get: {
        tags: ["Applications"],
        summary: "Read one application",
        description: "Readable by the application's session holder or with the admin API key.",
        operationId: "getApplication",
        security: [{ workflowSession: [] }, { adminKey: [] }],
        parameters: [{ $ref: "#/components/parameters/ApplicationId" }],
        responses: {
          200: ok("ApplicationDetail", "Application with masked personal data"),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },

    "/applications/{applicationId}/events": {
      get: {
        tags: ["Applications"],
        summary: "Audit trail",
        operationId: "getApplicationEvents",
        security: [{ workflowSession: [] }, { adminKey: [] }],
        parameters: [{ $ref: "#/components/parameters/ApplicationId" }],
        responses: {
          200: ok("EventList", "Ordered workflow events"),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },

    "/sessions": {
      post: {
        tags: ["Sessions"],
        summary: "Open a session for another actor",
        description:
          "Operator-only session issuance. The admin API key is required for every actor. " +
          "Borrower sessions are issued during application creation or verified recovery.",
        operationId: "createSession",
        security: adminKey,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["applicationId", "actor"],
                properties: {
                  applicationId: { type: "string", format: "uuid" },
                  actor: {
                    type: "string",
                    enum: ["BORROWER", "COBORROWER", "LENDER", "MANAGER"],
                  },
                },
              },
            },
          },
        },
        responses: {
          201: ok("Session", "Session token"),
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
        },
      },
    },

    "/workflow/state": {
      get: {
        tags: ["Workflow"],
        summary: "Current node for the session's actor",
        operationId: "getWorkflowState",
        security: bearerSession,
        responses: {
          200: ok("WorkflowState", "Node, access rules and whether a step can be submitted"),
          401: errorResponse,
        },
      },
    },

    "/workflow/events": {
      post: {
        tags: ["Workflow"],
        summary: "Complete the step that is currently waiting",
        description:
          "`node` must equal the application's current node, otherwise the call fails with 409 " +
          "`STEP_OUT_OF_SEQUENCE`. Supply a stable `eventId` in the body or `Idempotency-Key` " +
          "header and reuse it with the same payload after a timeout. Reusing it with different " +
          "data returns 409. The payload schema for `data` depends on the node — see `x-node-schemas`.",
        operationId: "submitWorkflowStep",
        security: bearerSession,
        parameters: [
          {
            name: "Idempotency-Key",
            in: "header",
            required: false,
            schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/StepSubmission" },
            },
          },
        },
        responses: {
          200: ok("WorkflowMutation", "Step accepted; returns the node the flow moved to"),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          422: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },

    "/workflow/nodes": {
      get: {
        tags: ["Workflow"],
        summary: "List flow nodes",
        operationId: "listNodes",
        security: adminKey,
        responses: { 200: ok("NodeList", "Every node in the current definition") },
      },
    },

    "/workflow/nodes/{nodeKey}": {
      get: {
        tags: ["Workflow"],
        summary: "Describe one node",
        operationId: "describeNode",
        security: adminKey,
        parameters: [{ $ref: "#/components/parameters/NodeKey" }],
        responses: { 200: ok("NodeDescription", "Access rules and outgoing edges"), 404: errorResponse },
      },
    },

    "/auth/challenges": {
      post: {
        tags: ["Authentication"],
        summary: "Start an OTP challenge",
        description:
          "`MOBILE_OTP` takes `mobileNumber`, `AADHAAR` takes `aadhaarNumber` (12 digits). " +
          "With `AUTH_DEV_MODE=true` the code is returned in the response.",
        operationId: "startAuthChallenge",
        security: bearerSession,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["method", "subject"],
                properties: {
                  method: { type: "string", enum: ["MOBILE_OTP", "AADHAAR"] },
                  subject: { type: "string", description: "Mobile number or Aadhaar number" },
                },
              },
            },
          },
        },
        responses: {
          201: ok("AuthChallenge", "Challenge created"),
          401: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },

    "/auth/challenges/{challengeId}/verify": {
      post: {
        tags: ["Authentication"],
        summary: "Verify the code",
        operationId: "verifyAuthChallenge",
        security: bearerSession,
        parameters: [
          { name: "challengeId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code"],
                properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
              },
            },
          },
        },
        responses: {
          200: ok("AuthResult", "Authentication recorded"),
          401: errorResponse,
          409: errorResponse,
        },
      },
    },

    // ── Recovery ────────────────────────────────────────────────────────────
    // Resuming an existing application when the session is gone. The workflow
    // id is an identifier, never proof; only a verified factor mints a session.
    "/workflow/recovery/start": {
      post: {
        tags: ["Recovery"],
        summary: "Start proving ownership of an existing application",
        description:
          "Validates the workflow, the actor and the recovery policy, then creates a " +
          "short-lived challenge listing the factors that must be proven. CAPTCHA is " +
          "required when the policy enables it but is never the only factor. The " +
          "response never contains applicant PII.",
        operationId: "startRecovery",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["workflowId"],
                properties: {
                  workflowId: { type: "string", pattern: "^WF-[0-9a-fA-F-]{36}$" },
                  actor: { type: "string", enum: ["BORROWER", "COBORROWER"] },
                  captchaToken: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          201: ok("RecoveryChallenge", "Challenge created; no session yet"),
          400: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },

    "/workflow/recovery/otp/request": {
      post: {
        tags: ["Recovery"],
        summary: "Send a code to the number already on file",
        description:
          "The number is chosen by the server from the applicant record and is never " +
          "returned. Sends are capped per challenge and throttled per resend interval.",
        operationId: "requestRecoveryOtp",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recoveryId"],
                properties: { recoveryId: { type: "string", format: "uuid" } },
              },
            },
          },
        },
        responses: {
          201: ok("RecoveryDelivery", "Code dispatched"),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },

    "/workflow/recovery/otp/verify": {
      post: {
        tags: ["Recovery"],
        summary: "Verify the code",
        description:
          "Single use: a code that has already verified is refused even if it is " +
          "presented again. Attempts are counted per challenge and lock it when spent.",
        operationId: "verifyRecoveryOtp",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recoveryId", "code"],
                properties: {
                  recoveryId: { type: "string", format: "uuid" },
                  code: { type: "string", pattern: "^[0-9]{6}$" },
                },
              },
            },
          },
        },
        responses: {
          200: ok("RecoveryVerification", "Factor recorded; more may still be required"),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
        },
      },
    },

    "/workflow/recovery/complete": {
      post: {
        tags: ["Recovery"],
        summary: "Exchange a satisfied challenge for a session",
        description:
          "Re-checks every required factor inside one transaction, consumes the " +
          "challenge exactly once and issues a fresh session for the original " +
          "workflow and actor. Never creates an application.",
        operationId: "completeRecovery",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["recoveryId"],
                properties: { recoveryId: { type: "string", format: "uuid" } },
              },
            },
          },
        },
        responses: {
          200: ok("RecoverySession", "Session issued for the original workflow"),
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },

    "/internal/workflow/applications/{applicationId}/steps/{nodeKey}": {
      post: {
        tags: ["Internal"],
        summary: "Record a system step result",
        description:
          "Only for nodes in `x-internal-schemas`. The node must be the application's current node. " +
          "Verification data accepted here is what the rule engine trusts. Send a stable " +
          "`Idempotency-Key` and reuse it after a timeout.",
        operationId: "completeInternalStep",
        security: internalToken,
        parameters: [
          { $ref: "#/components/parameters/ApplicationId" },
          { $ref: "#/components/parameters/NodeKey" },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            schema: { type: "string", minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: { data: { type: "object", additionalProperties: true } },
              },
            },
          },
        },
        responses: {
          200: ok("WorkflowMutation", "Result recorded; flow continued"),
          401: errorResponse,
          409: errorResponse,
          422: errorResponse,
        },
      },
    },
  },

  // Node → request/response payload schema. Consumed by clients and by
  // `scripts/validate-openapi.js`, which checks coverage against the flow.
  "x-node-schemas": {
    "BORROWER-DETAILS-V1-PERSONAL-INFO-V1": "PersonalInfo",
    "BORROWER-ADDRESS-V1-ADDRESS-INFO-V1": "Address",
    "BORROWER-KYC-V1-KYC-UPLOAD-V1": "KycUpload",
    "BORROWER-KYC-V1-AADHAR-VERIFICATION-V1": "EmptyPayload",
    "BORROWER-EMPLOYMENT-V1-EMPLOYMENT-INFO-V1": "Employment",
    "BORROWER-SALARY-V1-SALARY-INFO-V1": "Salary",
    "BORROWER-BUSINESS-V1-BUSINESS-INFO-V1": "Business",
    "BORROWER-BANK-V1-BANK-DETAILS-V1": "BankDetails",
    "BORROWER-BANK-V1-BANK-STATEMENT-UPLOAD-V1": "BankStatement",
    "BORROWER-DOCUMENT-V1-DOCUMENT-UPLOAD-V1": "Documents",
    "BORROWER-CONSENT-V1-LOAN-CONSENT-V1": "Consent",
    "COBORROWER-DETAILS-V1-PERSONAL-INFO-V1": "PersonalInfo",
    "COBORROWER-ADDRESS-V1-ADDRESS-INFO-V1": "Address",
    "COBORROWER-KYC-V1-KYC-UPLOAD-V1": "KycUpload",
    "COBORROWER-EMPLOYMENT-V1-EMPLOYMENT-INFO-V1": "Employment",
    "COBORROWER-SALARY-V1-SALARY-INFO-V1": "Salary",
    "COBORROWER-BUSINESS-V1-BUSINESS-INFO-V1": "Business",
    "COBORROWER-BANK-V1-BANK-DETAILS-V1": "CoborrowerBankDetails",
    "LENDER-OFFER-V1-LOAN-AMOUNT-V1": "LoanAmount",
    "LENDER-OFFER-V1-LOAN-OFFER-V1": "LoanOffer",
    "LENDER-AGREEMENT-V1-ESIGN-V1": "Esign",
    "LENDER-MANDATE-V1-MANDATE-SETUP-V1": "Mandate",
    "LENDER-DISBURSEMENT-V1-DISBURSEMENT-FAILED-V1": "DisbursementRetry",
    "MANAGER-REVIEW-V1-CREDIT-EXCEPTION-V1": "ManagerDecision",
    "MANAGER-REVIEW-V1-FRAUD-REVIEW-V1": "FraudReviewDecision",
    "MANAGER-REVIEW-V1-DOCUMENT-REVIEW-V1": "ManagerDecision",
    "MANAGER-REVIEW-V1-RISK-REVIEW-V1": "ManagerDecision",
    "MANAGER-REVIEW-V1-ELIGIBILITY-REVIEW-V1": "ManagerDecision",
    "MANAGER-FRAUD-CHECK-V1-FRAUD-CHECK-PENDING-V1": "FraudCheckDecision",
    "MANAGER-APPROVAL-V1-FINAL-APPROVAL-V1": "ManagerDecision",
    "MANAGER-APPROVAL-V1-DISBURSEMENT-REVIEW-V1": "ManagerDecision",
  },

  "x-internal-schemas": {
    "BORROWER-KYC-V1-FACE-VERIFICATION-V1": "FaceVerification",
    "BORROWER-KYC-V1-VERIFICATION-PENDING-V1": "FaceVerification",
    "COBORROWER-KYC-V1-FACE-VERIFICATION-V1": "FaceVerification",
    "BORROWER-KYC-V1-PAN-VERIFICATION-V1": "PanVerification",
    "COBORROWER-KYC-V1-PAN-VERIFICATION-V1": "PanVerification",
    "COBORROWER-KYC-V1-AADHAR-VERIFICATION-V1": "AadhaarVerification",
    "BORROWER-BANK-V1-BANK-ACCOUNT-VERIFICATION-V1": "BankVerification",
    "BORROWER-CREDIT-V1-CREDIT-CHECK-V1": "CreditCheck",
    "LENDER-CREDIT-V1-CREDIT-CHECK-V1": "LenderCreditCheck",
    "LENDER-FRAUD-V1-FRAUD-CHECK-V1": "FraudCheck",
    "LENDER-DOCUMENT-V1-DOCUMENT-VERIFICATION-V1": "DocumentVerification",
    "LENDER-RISK-V1-RISK-ASSESSMENT-V1": "RiskAssessment",
    "LENDER-ELIGIBILITY-V1-ELIGIBILITY-CHECK-V1": "EligibilityCheck",
    "LENDER-DISBURSEMENT-V1-DISBURSEMENT-CONFIRMATION-V1": "DisbursementConfirmation",
  },

  components: {
    securitySchemes: {
      workflowSession: {
        type: "apiKey",
        in: "header",
        name: "x-workflow-session",
        description: "Opaque session token issued by `POST /applications` or `POST /sessions`.",
      },
      adminKey: { type: "apiKey", in: "header", name: "x-api-key" },
      internalToken: { type: "apiKey", in: "header", name: "x-internal-token" },
    },
    parameters: {
      ApplicationId: {
        name: "applicationId",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
      NodeKey: {
        name: "nodeKey",
        in: "path",
        required: true,
        schema: { type: "string", example: "BORROWER-DETAILS-V1-PERSONAL-INFO-V1" },
      },
    },
    schemas: {
      ErrorEnvelope: {
        type: "object",
        required: ["success", "status", "code", "message"],
        properties: {
          success: { type: "boolean", const: false },
          status: { type: "string", const: "ERROR" },
          code: {
            type: "string",
            examples: [
              "VALIDATION_FAILED",
              "STEP_OUT_OF_SEQUENCE",
              "SESSION_INVALID",
              "SESSION_EXPIRED",
              "UNAUTHORIZED",
              "NO_TRANSITION",
              "CAPTCHA_REQUIRED",
              "CAPTCHA_INVALID",
              "RECOVERY_REQUIRED",
              "RECOVERY_CHALLENGE_EXPIRED",
              "RECOVERY_ATTEMPTS_EXCEEDED",
              "IDENTITY_PROVIDER_UNAVAILABLE",
              "WORKFLOW_NOT_FOUND",
              "WORKFLOW_NOT_RECOVERABLE",
            ],
          },
          message: { type: "string" },
          details: { type: "object", additionalProperties: true },
        },
      },
      Health: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          status: { type: "string" },
          data: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok", "degraded"] },
              database: { type: "string", enum: ["up", "down"] },
              workflowVersion: { type: "string" },
              uptimeSeconds: { type: "integer" },
            },
          },
        },
      },
      CaptchaConfig: {
        type: "object",
        properties: {
          version: { type: "string", const: "v2" },
          siteKey: { type: ["string", "null"], description: "Public key for the widget" },
          required: { type: "boolean" },
          bypassed: { type: "boolean", description: "Development bypass is active" },
        },
      },
      ApplicationSummary: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          applicationNo: { type: "string", example: "LN-20261026-8F3A1C" },
          workflowId: { type: "string", example: "WF-3f2b0c3e-..." },
          definitionVersion: { type: "string", example: "LOAN-FLOW-V7" },
          status: { type: "string", enum: ["IN_PROGRESS", "APPROVED", "REJECTED", "CANCELLED"] },
          currentNode: { type: "string" },
          currentActor: { type: "string", enum: ["BORROWER", "COBORROWER", "LENDER", "MANAGER"] },
          requiresCoborrower: { type: "boolean" },
          requestedAmount: { type: ["number", "null"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      NodeAccess: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["PUBLIC", "ACTOR", "INTERNAL"] },
          captcha: { type: "object", properties: { required: { type: "boolean" } } },
          authentication: {
            type: "object",
            properties: {
              required: { type: "boolean" },
              methods: { type: ["array", "null"], items: { type: "string", enum: ["MOBILE_OTP", "AADHAAR"] } },
            },
          },
        },
      },
      NodeView: {
        type: "object",
        properties: {
          node: { type: "string" },
          component: { type: ["string", "null"] },
          componentView: {
            type: "object",
            properties: {
              module: { type: ["string", "null"] },
              componentKey: { type: ["string", "null"] },
            },
          },
          terminal: { type: "boolean" },
          access: { $ref: "#/components/schemas/NodeAccess" },
          actor: { type: ["string", "null"] },
        },
      },
      Session: {
        type: "object",
        properties: {
          token: { type: "string" },
          header: { type: "string", const: "x-workflow-session" },
          actor: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      CreatedApplication: {
        type: "object",
        properties: {
          session: { $ref: "#/components/schemas/Session" },
          application: { $ref: "#/components/schemas/ApplicationSummary" },
          node: { $ref: "#/components/schemas/NodeView" },
          actorStatus: { type: "string", enum: ["ACTIVE", "WAITING", "NOT_YOUR_TURN"] },
          canSubmit: { type: "boolean" },
        },
      },
      WorkflowMutation: {
        type: "object",
        properties: {
          application: { $ref: "#/components/schemas/ApplicationSummary" },
          node: { $ref: "#/components/schemas/NodeView" },
          actorStatus: { type: "string", enum: ["ACTIVE", "WAITING"] },
          canSubmit: { type: "boolean" },
        },
      },
      WorkflowState: {
        type: "object",
        properties: {
          application: { $ref: "#/components/schemas/ApplicationSummary" },
          node: { $ref: "#/components/schemas/NodeView" },
          actorStatus: { type: "string", enum: ["ACTIVE", "WAITING", "NOT_YOUR_TURN"] },
          message: { type: ["string", "null"] },
          canSubmit: { type: "boolean" },
          requiresAuthentication: { type: "boolean" },
          requiresCaptcha: { type: "boolean" },
          session: {
            type: "object",
            properties: {
              actor: { type: "string" },
              authenticated: { type: "boolean" },
              actorId: { type: ["string", "null"] },
            },
          },
        },
      },
      ApplicationList: {
        type: "object",
        properties: {
          total: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          applications: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                applicationNo: { type: "string" },
                workflowId: { type: "string" },
                status: { type: "string" },
                currentNode: { type: "string" },
                currentActor: { type: "string" },
                requestedAmount: { type: ["number", "null"] },
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
                completedAt: { type: ["string", "null"], format: "date-time" },
              },
            },
          },
        },
      },
      ApplicationDetail: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          applicationNo: { type: "string" },
          workflowId: { type: "string" },
          status: { type: "string" },
          currentNode: { type: "string" },
          currentActor: { type: "string" },
          requiresCoborrower: { type: "boolean" },
          requestedAmount: { type: ["number", "null"] },
          borrower: { type: ["object", "null"], additionalProperties: true },
          coborrower: { type: ["object", "null"], additionalProperties: true },
          consents: { type: "array", items: { type: "object", additionalProperties: true } },
          credit: { type: ["object", "null"], additionalProperties: true },
          offer: { type: ["object", "null"], additionalProperties: true },
          disbursement: { type: ["object", "null"], additionalProperties: true },
          decisions: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      EventList: {
        type: "object",
        properties: {
          application: { $ref: "#/components/schemas/ApplicationSummary" },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sequence: { type: "integer" },
                event_type: { type: "string", enum: ["STEP_COMPLETED", "SYSTEM_STEP"] },
                node_key: { type: "string" },
                actor: { type: "string" },
                from_node: { type: ["string", "null"] },
                to_node: { type: ["string", "null"] },
                edge_id: { type: ["string", "null"] },
                occurred_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      NodeList: {
        type: "object",
        properties: {
          workflowVersion: { type: "string" },
          startState: { type: "string" },
          nodes: { type: "array", items: { type: "string" } },
        },
      },
      NodeDescription: {
        allOf: [
          { $ref: "#/components/schemas/NodeView" },
          {
            type: "object",
            properties: {
              next: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    edgeId: { type: "string" },
                    to: { type: "string" },
                    type: { type: "string", enum: ["AND", "OR"] },
                    conditions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          field: { type: "string" },
                          operator: { type: "string", enum: ["=", "!=", ">", "<", ">=", "<="] },
                          value: {},
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
      AuthChallenge: {
        type: "object",
        properties: {
          challengeId: { type: "string", format: "uuid" },
          method: { type: "string", enum: ["MOBILE_OTP", "AADHAAR"] },
          expiresAt: { type: "string", format: "date-time" },
          delivery: { type: "string", enum: ["RESPONSE", "GATEWAY"] },
          code: { type: "string", description: "Only returned when AUTH_DEV_MODE=true" },
        },
      },
      AuthResult: {
        type: "object",
        properties: {
          method: { type: "string" },
          verifiedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      RecoveryChallenge: {
        type: "object",
        properties: {
          status: { type: "string", const: "AUTHENTICATION_REQUIRED" },
          workflowId: { type: "string" },
          recoveryId: { type: "string", format: "uuid" },
          requiredMethods: { type: "array", items: { type: "string" } },
          availableMethods: { type: "array", items: { type: "string" } },
          verifiedMethods: { type: "array", items: { type: "string" } },
          missingMethods: { type: "array", items: { type: "string" } },
          nextStep: {
            type: "string",
            enum: ["CAPTCHA", "MOBILE_OTP", "AADHAAR", "COMPLETE"],
          },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      RecoveryDelivery: {
        type: "object",
        properties: {
          recoveryId: { type: "string", format: "uuid" },
          method: { type: "string", const: "MOBILE_OTP" },
          sentTo: { type: "string", description: "Never the number itself" },
          expiresAt: { type: "string", format: "date-time" },
          resendAfterSeconds: { type: "integer" },
          sendsRemaining: { type: "integer" },
          delivery: { type: "string", enum: ["RESPONSE", "LOG", "GATEWAY"] },
          code: { type: "string", description: "Only returned when AUTH_DEV_MODE=true" },
        },
      },
      RecoveryVerification: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["OK", "AUTHENTICATION_REQUIRED"] },
          recoveryId: { type: "string", format: "uuid" },
          verifiedMethods: { type: "array", items: { type: "string" } },
          missingMethods: { type: "array", items: { type: "string" } },
          nextStep: { type: "string" },
        },
      },
      RecoverySession: {
        type: "object",
        properties: {
          status: { type: "string", const: "OK" },
          workflowId: { type: "string", description: "The original workflow, never a new one" },
          sessionId: { type: "string" },
          actor: { type: "string", enum: ["BORROWER", "COBORROWER", "LENDER", "MANAGER"] },
          expiresAt: { type: "string", format: "date-time" },
          workflow: { type: "object", additionalProperties: true },
        },
      },
      StepSubmission: {
        type: "object",
        required: ["node", "data"],
        properties: {
          node: { type: "string", description: "Must equal the application's current node" },
          eventId: {
            type: "string",
            minLength: 16,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._~-]+$",
            description: "Stable idempotency key; alternatively supplied in the Idempotency-Key header",
          },
          data: {
            type: "object",
            additionalProperties: true,
            description: "Payload for this node; the schema is listed in `x-node-schemas`.",
          },
          captchaToken: {
            type: "string",
            description: "Required when the node's access block declares captcha.required",
          },
        },
      },

      // ── Actor step payloads ────────────────────────────────────────────────
      EmptyPayload: { type: "object", properties: {} },
      PersonalInfo: {
        type: "object",
        required: ["fullName", "dateOfBirth", "gender", "mobileNumber", "pan"],
        properties: {
          fullName: { type: "string", maxLength: 120 },
          fatherName: { type: "string", maxLength: 120 },
          motherName: { type: "string", maxLength: 120 },
          dateOfBirth: { type: "string", format: "date", description: "Applicant must be 18 or older" },
          gender: { type: "string", enum: ["MALE", "FEMALE", "OTHER"] },
          maritalStatus: { type: "string", enum: ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "OTHER"] },
          email: { type: "string", format: "email" },
          mobileNumber: { type: "string", pattern: "^[6-9][0-9]{9}$" },
          pan: { type: "string", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$" },
          aadhaar: { type: "string", pattern: "^[0-9]{12}$" },
          loanPurpose: { type: "string", maxLength: 200 },
        },
      },
      Address: {
        type: "object",
        required: ["street", "city", "state", "pincode"],
        properties: {
          flatNo: { type: "string", maxLength: 40 },
          building: { type: "string", maxLength: 120 },
          street: { type: "string", maxLength: 200 },
          landmark: { type: "string", maxLength: 120 },
          city: { type: "string", maxLength: 80 },
          district: { type: "string", maxLength: 80 },
          state: { type: "string", maxLength: 80 },
          pincode: { type: "string", pattern: "^[1-9][0-9]{5}$" },
          residenceType: { type: "string", maxLength: 40 },
        },
      },
      KycUpload: {
        type: "object",
        required: ["aadhaarFileUrl", "panFileUrl"],
        properties: {
          aadhaarFileUrl: { type: "string", maxLength: 2048 },
          panFileUrl: { type: "string", maxLength: 2048 },
        },
      },
      Employment: {
        type: "object",
        required: ["employmentType"],
        properties: {
          employmentType: { type: "string", enum: ["SALARIED", "BUSINESS_OWNER", "UNEMPLOYED"] },
          employerName: { type: "string", maxLength: 160, description: "Required when SALARIED" },
          designation: { type: "string", maxLength: 120 },
          workingSince: { type: "string", format: "date" },
          isActive: { type: "boolean", description: "Must be true when SALARIED" },
          monthlyIncome: { type: "number", minimum: 0 },
          business: {
            type: "object",
            description: "Required when BUSINESS_OWNER",
            properties: {
              registrationExists: { type: "boolean", description: "Must be true" },
              registrationNumber: { type: "string", maxLength: 60 },
            },
          },
        },
      },
      Salary: {
        type: "object",
        required: ["monthlyIncome", "employerVerified"],
        properties: {
          monthlyIncome: { type: "number", minimum: 0 },
          employerVerified: { type: "boolean" },
        },
      },
      Business: {
        type: "object",
        required: ["registrationVerified"],
        properties: {
          registrationVerified: { type: "boolean" },
          annualRevenue: { type: "number", minimum: 0 },
        },
      },
      BankDetails: {
        type: "object",
        required: ["accountNumber", "ifsc", "holderName"],
        properties: {
          accountNumber: { type: "string", pattern: "^[0-9]{9,18}$" },
          ifsc: { type: "string", pattern: "^[A-Z]{4}0[A-Z0-9]{6}$" },
          holderName: { type: "string", maxLength: 160 },
          bankName: { type: "string", maxLength: 120 },
          branch: { type: "string", maxLength: 120 },
        },
      },
      CoborrowerBankDetails: {
        allOf: [
          { $ref: "#/components/schemas/BankDetails" },
          {
            type: "object",
            required: ["consentGiven", "accountVerified"],
            properties: {
              consentGiven: { type: "boolean" },
              accountVerified: { type: "boolean" },
            },
          },
        ],
      },
      BankStatement: {
        type: "object",
        required: ["fileUrl"],
        properties: {
          fileUrl: { type: "string", maxLength: 2048 },
          valid: { type: "boolean", default: true },
        },
      },
      Documents: {
        type: "object",
        properties: {
          documents: {
            type: "array",
            items: {
              type: "object",
              required: ["type", "fileUrl"],
              properties: {
                type: { type: "string", enum: ["ADDRESS_PROOF", "INCOME_PROOF"] },
                fileUrl: { type: "string", maxLength: 2048 },
              },
            },
          },
        },
      },
      Consent: {
        type: "object",
        required: ["consentGiven"],
        properties: { consentGiven: { type: "boolean", const: true } },
      },
      LoanAmount: {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "number", minimum: 1, maximum: 100000000 } },
      },
      LoanOffer: {
        type: "object",
        required: ["accepted"],
        properties: { accepted: { type: "boolean" } },
      },
      Esign: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["SIGNED", "FAILED"] } },
      },
      Mandate: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ACTIVE"] } },
      },
      DisbursementRetry: {
        type: "object",
        required: ["retry"],
        properties: { retry: { type: "boolean" } },
      },
      ManagerDecision: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
          remarks: { type: "string", maxLength: 1000 },
        },
      },
      FraudReviewDecision: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["CLEAR", "REJECTED"] },
          remarks: { type: "string", maxLength: 1000 },
        },
      },
      FraudCheckDecision: {
        type: "object",
        required: ["decision"],
        properties: {
          decision: { type: "string", enum: ["CLEAR", "FLAGGED"] },
          remarks: { type: "string", maxLength: 1000 },
        },
      },

      // ── Internal step payloads ─────────────────────────────────────────────
      FaceVerification: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["VERIFIED", "FAILED", "PENDING"] },
          score: { type: "number", minimum: 0, maximum: 100, description: "Required unless PENDING" },
          livenessPassed: { type: "boolean", description: "Required unless PENDING" },
          provider: { type: "string", maxLength: 60 },
          reference: { type: "string", maxLength: 120 },
        },
      },
      PanVerification: {
        type: "object",
        required: ["status", "nameMatched"],
        properties: {
          status: { type: "string", enum: ["VERIFIED", "FAILED", "PENDING"] },
          nameMatched: { type: "boolean" },
          blacklisted: { type: "boolean", default: false },
          provider: { type: "string", maxLength: 60 },
          reference: { type: "string", maxLength: 120 },
        },
      },
      AadhaarVerification: {
        type: "object",
        required: ["status", "mobileLinked"],
        properties: {
          status: { type: "string", enum: ["VERIFIED", "FAILED"] },
          mobileLinked: { type: "boolean" },
          provider: { type: "string", maxLength: 60 },
          reference: { type: "string", maxLength: 120 },
        },
      },
      BankVerification: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["VERIFIED", "FAILED"] },
          holderName: { type: "string", maxLength: 160 },
          bankName: { type: "string", maxLength: 120 },
          branch: { type: "string", maxLength: 120 },
        },
      },
      CreditCheck: {
        type: "object",
        required: ["creditScore", "consentGiven"],
        properties: {
          creditScore: { type: "integer", minimum: 0, maximum: 1000 },
          consentGiven: { type: "boolean", const: true },
        },
      },
      LenderCreditCheck: {
        type: "object",
        required: ["creditScore"],
        properties: { creditScore: { type: "integer", minimum: 0, maximum: 1000 } },
      },
      FraudCheck: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["CLEAR", "REVIEW", "CONFIRMED"] } },
      },
      DocumentVerification: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["VERIFIED", "REVIEW", "FAILED"] } },
      },
      RiskAssessment: {
        type: "object",
        required: ["riskScore"],
        properties: { riskScore: { type: "integer", minimum: 0, maximum: 100 } },
      },
      EligibilityCheck: {
        type: "object",
        required: ["status"],
        properties: { status: { type: "string", enum: ["ELIGIBLE", "EXCEPTION", "INELIGIBLE"] } },
      },
      DisbursementConfirmation: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["COMPLETED", "FAILED"] },
          providerReference: { type: "string", maxLength: 120 },
          failureReason: { type: "string", maxLength: 500 },
          retryAllowed: { type: "boolean" },
        },
      },
    },
  },
};

module.exports = document;
