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

  neo4j: {
    enabled: readBoolean("NEO4J_ENABLED", false),
    uri: readString("NEO4J_URI", "bolt://localhost:7687"),
    username: readString("NEO4J_USERNAME", "neo4j"),
    password: readString("NEO4J_PASSWORD", ""),
  },

  corsOrigins: readList("CORS_ORIGINS"),

  security: {
    adminApiKey: readString("ADMIN_API_KEY"),
    internalToken: readString("INTERNAL_SERVICE_TOKEN"),
    piiPepper: readString("PII_HASH_PEPPER"),
    bodyLimit: readString("REQUEST_BODY_LIMIT", "256kb"),
  },

  session: {
    workflowTtlMinutes: readNumber("WORKFLOW_SESSION_TTL_MINUTES", 30),
    actorTtlMinutes: readNumber("ACTOR_SESSION_TTL_MINUTES", 15),
    challengeTtlMinutes: readNumber("AUTH_CHALLENGE_TTL_MINUTES", 5),
    recoveryTtlHours: readNumber("WORKFLOW_RECOVERY_TTL_HOURS", 168),
  },

  recaptcha: {
    version: "v2",
    siteKey: readString("RECAPTCHA_SITE_KEY"),
    secretKey: readString("RECAPTCHA_SECRET_KEY"),
    allowedHostnames: readList("RECAPTCHA_ALLOWED_HOSTNAMES"),
    devBypass: readBoolean("RECAPTCHA_DEV_BYPASS", false),
  },

  auth: {
    devMode: readBoolean("AUTH_DEV_MODE", false),
  },

  recovery: {
    enabled: readBoolean("RECOVERY_ENABLED", true),
    otpEnabled: readBoolean("RECOVERY_OTP_ENABLED", true),
    identityEnabled: readBoolean("RECOVERY_IDENTITY_ENABLED", false),
    captchaEnabled: readBoolean("RECOVERY_CAPTCHA_ENABLED", true),
    requireRegisteredMobile: readBoolean("RECOVERY_REQUIRE_REGISTERED_MOBILE", true),
    requireIdentity: readBoolean("RECOVERY_REQUIRE_IDENTITY", false),
    smsProvider: readString("SMS_PROVIDER", "none"),
    challengeTtlMinutes: readNumber("RECOVERY_CHALLENGE_TTL_MINUTES", 15),
    maxAttempts: readNumber("RECOVERY_MAX_ATTEMPTS", 5),
    maxStartsPerHour: readNumber("RECOVERY_MAX_STARTS_PER_HOUR", 10),
    maxOtpSends: readNumber("RECOVERY_MAX_OTP_SENDS", 3),
    otpResendSeconds: readNumber("RECOVERY_OTP_RESEND_SECONDS", 60),
    lockoutMinutes: readNumber("RECOVERY_LOCKOUT_MINUTES", 15),
  },

  dev: {
    simulateInternalSteps: readBoolean("DEV_SIMULATE_INTERNAL_STEPS", false),
  },

  migrations: {
    runOnBoot: readBoolean("MIGRATE_ON_BOOT", false),
  },

  disbursement: {
    manualReviewThreshold: readNumber("DISBURSEMENT_MANUAL_REVIEW_THRESHOLD", 500000),
  },
};

function validateConfig(runtimeConfig = config) {
  const problems = [];

  if (!runtimeConfig.db.url) {
    problems.push("DATABASE_URL is required");
  }

  if (runtimeConfig.neo4j.enabled) {
    if (!runtimeConfig.neo4j.uri) {
      problems.push("NEO4J_URI is required when NEO4J_ENABLED=true");
    }
    if (!runtimeConfig.neo4j.username) {
      problems.push("NEO4J_USERNAME is required when NEO4J_ENABLED=true");
    }
    if (!runtimeConfig.neo4j.password) {
      problems.push("NEO4J_PASSWORD is required when NEO4J_ENABLED=true");
    }
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
