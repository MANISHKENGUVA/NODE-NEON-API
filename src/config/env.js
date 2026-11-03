/**
 * Environment configuration.
 *
 * Every setting is read once, validated once, and exported as a plain object.
 * Nothing else in the codebase touches `process.env`, so the full runtime
 * configuration can be reviewed in one place.
 */
require("dotenv").config();

function readString(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw;
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name, fallback = false) {
  return String(process.env[name] ?? "").toLowerCase() === "true" ? true : fallback;
}

function readList(name) {
  const raw = readString(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const nodeEnv = readString("NODE_ENV", "development");
const isProduction = nodeEnv === "production";

const config = {
  nodeEnv,
  isProduction,
  port: readNumber("PORT", 3000),

  db: {
    url: readString("DATABASE_URL"),
    poolMax: readNumber("DATABASE_POOL_MAX", 10),
  },

  // Empty list = allow any origin (development default). Production must set it.
  corsOrigins: readList("CORS_ORIGINS"),

  security: {
    // Needed by GET /api/applications and admin-only reads.
    adminApiKey: readString("ADMIN_API_KEY"),
    // Needed by flow nodes that only internal services may complete.
    internalToken: readString("INTERNAL_SERVICE_TOKEN"),
    // Pepper for PAN/Aadhaar hashes so the stored digests cannot be brute forced.
    piiPepper: readString("PII_HASH_PEPPER"),
    bodyLimit: readString("REQUEST_BODY_LIMIT", "256kb"),
  },

  session: {
    // Anonymous workflow session: 30 minutes. This is the continuity credential,
    // not proof of identity.
    workflowTtlMinutes: readNumber("WORKFLOW_SESSION_TTL_MINUTES", 30),
    // Actor authentication session: 15 minutes. Shorter than the workflow
    // session on purpose so a verified actor must re-prove themselves.
    actorTtlMinutes: readNumber("ACTOR_SESSION_TTL_MINUTES", 15),
    challengeTtlMinutes: readNumber("AUTH_CHALLENGE_TTL_MINUTES", 5),
    // Outlives the session on purpose: this is what survives a browser wipe.
    recoveryTtlHours: readNumber("WORKFLOW_RECOVERY_TTL_HOURS", 168),
  },

  recaptcha: {
    version: "v2",
    siteKey: readString("RECAPTCHA_SITE_KEY"),
    secretKey: readString("RECAPTCHA_SECRET_KEY"),
    allowedHostnames: readList("RECAPTCHA_ALLOWED_HOSTNAMES"),
    // Development escape hatch. Refused in production by validateConfig().
    devBypass: readBoolean("RECAPTCHA_DEV_BYPASS", false),
  },

  auth: {
    // Echoes OTP codes in the challenge response. Refused in production.
    devMode: readBoolean("AUTH_DEV_MODE", false),
  },

  recovery: {
    // Resuming an existing application when the browser lost its session.
    enabled: readBoolean("RECOVERY_ENABLED", true),
    otpEnabled: readBoolean("RECOVERY_OTP_ENABLED", true),
    // No identity provider is implemented in this build: leaving this false is
    // the only configuration that boots. See validateConfig().
    identityEnabled: readBoolean("RECOVERY_IDENTITY_ENABLED", false),
    captchaEnabled: readBoolean("RECOVERY_CAPTCHA_ENABLED", true),
    // OTP is only useful if there is a number on file to send it to.
    requireRegisteredMobile: readBoolean("RECOVERY_REQUIRE_REGISTERED_MOBILE", true),
    // Demands an identity check as well. No identity provider is implemented,
    // so turning this on makes recovery report IDENTITY_PROVIDER_UNAVAILABLE
    // instead of quietly downgrading to the cheaper factor.
    requireIdentity: readBoolean("RECOVERY_REQUIRE_IDENTITY", false),
    // `none` means no gateway is wired up; `dev` logs instead of sending and is
    // refused in production.
    smsProvider: readString("SMS_PROVIDER", "none"),
    challengeTtlMinutes: readNumber("RECOVERY_CHALLENGE_TTL_MINUTES", 15),
    maxAttempts: readNumber("RECOVERY_MAX_ATTEMPTS", 5),
    // New challenges per application per hour; stops a start-endpoint flood.
    maxStartsPerHour: readNumber("RECOVERY_MAX_STARTS_PER_HOUR", 10),
    maxOtpSends: readNumber("RECOVERY_MAX_OTP_SENDS", 3),
    otpResendSeconds: readNumber("RECOVERY_OTP_RESEND_SECONDS", 60),
    lockoutMinutes: readNumber("RECOVERY_LOCKOUT_MINUTES", 15),
  },

  dev: {
    // Stands in for the trusted services that complete INTERNAL nodes (face,
    // PAN, bank, bureau, fraud, document, risk, eligibility, disbursement) with
    // a deterministic happy-path verdict. Without a provider those nodes wait
    // forever, which makes the browser flow untestable locally. Refused in
    // production: an invented verification is not a verification.
    simulateInternalSteps: readBoolean("DEV_SIMULATE_INTERNAL_STEPS", false),
  },

  migrations: {
    runOnBoot: readBoolean("MIGRATE_ON_BOOT", false),
  },

  disbursement: {
    // Requests above this amount need a manager's manual review (ED81).
    manualReviewThreshold: readNumber("DISBURSEMENT_MANUAL_REVIEW_THRESHOLD", 500000),
  },
};

/**
 * Fails fast with an actionable message when the configuration cannot serve
 * traffic safely. Never prints secret values.
 */
function validateConfig(runtimeConfig = config) {
  const problems = [];

  if (!runtimeConfig.db.url) {
    problems.push("DATABASE_URL is required");
  }

  const positiveDurations = [
    ["WORKFLOW_SESSION_TTL_MINUTES", runtimeConfig.session.workflowTtlMinutes],
    ["ACTOR_SESSION_TTL_MINUTES", runtimeConfig.session.actorTtlMinutes],
    ["AUTH_CHALLENGE_TTL_MINUTES", runtimeConfig.session.challengeTtlMinutes],
    ["WORKFLOW_RECOVERY_TTL_HOURS", runtimeConfig.session.recoveryTtlHours],
    ["RECOVERY_CHALLENGE_TTL_MINUTES", runtimeConfig.recovery.challengeTtlMinutes],
    ["RECOVERY_OTP_RESEND_SECONDS", runtimeConfig.recovery.otpResendSeconds],
  ];
  for (const [name, value] of positiveDurations) {
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`${name} must be a positive number`);
    }
  }

  if (runtimeConfig.session.actorTtlMinutes > runtimeConfig.session.workflowTtlMinutes) {
    problems.push(
      "ACTOR_SESSION_TTL_MINUTES must not exceed WORKFLOW_SESSION_TTL_MINUTES; " +
        "an actor proof may not outlive the session that carries it"
    );
  }

  if (runtimeConfig.isProduction) {
    if (!runtimeConfig.security.adminApiKey) {
      problems.push("ADMIN_API_KEY is required in production");
    }
    if (!runtimeConfig.security.internalToken) {
      problems.push("INTERNAL_SERVICE_TOKEN is required in production");
    }
    if (!runtimeConfig.security.piiPepper) {
      problems.push("PII_HASH_PEPPER is required in production");
    }
    if (runtimeConfig.corsOrigins.length === 0) {
      problems.push("CORS_ORIGINS must list the trusted frontend origins in production");
    }
    if (runtimeConfig.auth.devMode) {
      problems.push("AUTH_DEV_MODE must be false in production");
    }
    if (runtimeConfig.recaptcha.devBypass) {
      problems.push("RECAPTCHA_DEV_BYPASS must be false in production");
    }
    if (runtimeConfig.dev.simulateInternalSteps) {
      problems.push("DEV_SIMULATE_INTERNAL_STEPS must be false in production");
    }
    if (runtimeConfig.recovery.smsProvider === "dev") {
      problems.push("SMS_PROVIDER=dev must not be used in production");
    }
  }

  if (runtimeConfig.recovery.identityEnabled) {
    // Deliberate: pretending to verify an identity is worse than not offering it.
    problems.push(
      "RECOVERY_IDENTITY_ENABLED is true but no identity provider is implemented in this build"
    );
  }

  if (problems.length > 0) {
    const error = new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    error.code = "INVALID_CONFIG";
    throw error;
  }

  return runtimeConfig;
}

module.exports = { config, validateConfig };
