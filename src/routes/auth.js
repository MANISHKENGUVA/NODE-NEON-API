/**
 * authentication routes — mounted at /api/auth
 *
 * POST /api/auth/challenge
 *   { sessionId, method, destination }
 *   → { challengeId, method, expiresAt }   (+ devCode only when AUTH_DEV_MODE=true)
 *
 * POST /api/auth/verify
 *   { sessionId, method, credential }
 *   → { authenticated: true, actorId, sessionId, authentication: {...} }
 *
 * The backend performs the actual verification through the method's
 * AuthenticationProvider — no claim from the frontend is trusted. Provider
 * secrets and verification details never appear in any response.
 */

const express = require("express");
const authenticationService = require("../authentication/authenticationService");

const router = express.Router();

router.post("/challenge", async (req, res, next) => {
  try {
    const { sessionId, method, destination } = req.body ?? {};
    if (!sessionId || !method) {
      return res.status(400).json({
        status: "ERROR",
        authenticated: false,
        message: "sessionId and method are required",
      });
    }

    const result = await authenticationService.createChallenge({
      sessionId,
      method,
      destination,
    });
    res.status(result.httpStatus ?? 200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/verify", async (req, res, next) => {
  try {
    const { sessionId, method, credential } = req.body ?? {};
    if (!sessionId || !method || credential === undefined) {
      return res.status(400).json({
        status: "ERROR",
        authenticated: false,
        message: "sessionId, method and credential are required",
      });
    }

    const result = await authenticationService.verify({
      sessionId,
      method,
      credential,
      remoteIp: req.ip,
    });
    res.status(result.httpStatus ?? 200).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
