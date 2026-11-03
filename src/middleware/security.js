/**
 * Cross-cutting HTTP security: headers, CORS and rate limiting.
 */
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const { config } = require("../config/env");
const { tooManyRequests } = require("../core/errors");

function buildCorsOptions() {
  const allowlist = config.corsOrigins;

  return {
    origin(origin, callback) {
      // Same-origin and server-to-server requests send no Origin header.
      if (!origin) return callback(null, true);
      // No allowlist configured = development: reflect whatever origin asks.
      if (allowlist.length === 0) return callback(null, true);
      // Deny by omitting the CORS headers; the browser blocks the response.
      return callback(null, allowlist.includes(origin));
    },
    // Reflected origins only — never `*`. A browser sending
    // `credentials: 'include'` is rejected unless this is exactly "true", and
    // `*` is illegal alongside it.
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    // `allowedHeaders` is deliberately omitted: the `cors` package then mirrors
    // Access-Control-Request-Headers, so adding a header to a call can never
    // break the preflight.
    exposedHeaders: ["x-request-id", "Retry-After"],
    maxAge: 600,
  };
}

/**
 * Fixed-window rate limiter, in-process.
 *
 * Enough for a single Node instance and for slowing down credential/bot abuse.
 * A multi-instance deployment should move this to a shared store.
 */
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();

  // Drop expired buckets so the map cannot grow without bound.
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref?.();

  return function rateLimitMiddleware(req, res, next) {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const bucket = hits.get(key);

    if (!bucket || bucket.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return next(tooManyRequests("Too many requests. Please try again shortly."));
    }

    return next();
  };
}

function applySecurity(app) {
  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: config.security.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.security.bodyLimit }));
}

module.exports = { applySecurity, rateLimit };
