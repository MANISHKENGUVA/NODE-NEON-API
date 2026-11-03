-- ============================================================================
-- 004_recovery_challenges.sql — verifiable resume of an existing application
--
-- A recovery credential (003) resumes silently when the browser still holds it.
-- This table is the other half: when the credential is gone, the claimant must
-- prove they own the application before a session is minted.
--
-- One row per recovery attempt. It records which factors the policy demanded,
-- which have been satisfied, and how many times the claimant may still try.
-- The factors themselves are verified elsewhere:
--
--   OTP      -> auth_challenges (purpose = 'RECOVERY'), digest only
--   CAPTCHA  -> captchaService (Google), single use by the provider
--   Identity -> no provider is configured in this build, so it is never offered
--
-- Nothing here can mint a session on its own: completion re-checks every
-- required factor inside one transaction.
-- ============================================================================

CREATE TABLE workflow_recovery_challenges (
  recovery_id         UUID PRIMARY KEY,
  application_id      UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  -- Denormalised so a mismatched workflowId is refused without touching the
  -- application row, and so an audit can read the challenge alone.
  workflow_id         TEXT NOT NULL,
  workflow_actor      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
  -- What the policy demanded when this challenge was created. Frozen here so a
  -- configuration change cannot relax an attempt that is already in flight.
  required_methods    TEXT[] NOT NULL DEFAULT '{}',
  captcha_verified_at TIMESTAMPTZ,
  otp_verified_at     TIMESTAMPTZ,
  identity_verified_at TIMESTAMPTZ,
  otp_sends           INTEGER NOT NULL DEFAULT 0,
  otp_last_sent_at    TIMESTAMPTZ,
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL,
  locked_until        TIMESTAMPTZ,
  consumed_at         TIMESTAMPTZ,
  -- The session minted by a successful completion, for audit only.
  session_id          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL
);

CREATE INDEX ix_recovery_challenges_app
  ON workflow_recovery_challenges (application_id, created_at DESC);

CREATE INDEX ix_recovery_challenges_expiry
  ON workflow_recovery_challenges (expires_at);

COMMENT ON TABLE workflow_recovery_challenges IS
  'One row per attempt to resume an existing application; consumed exactly once.';

-- ── Reuse the existing challenge table for the OTP factor ───────────────────
-- `auth_challenges` already stores a digest, an attempt counter and an expiry.
-- A recovery code is the same object with a different owner, so it gains an
-- owner column instead of a second table.
ALTER TABLE auth_challenges
  ADD COLUMN IF NOT EXISTS recovery_id UUID
    REFERENCES workflow_recovery_challenges (recovery_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'SESSION';

ALTER TABLE auth_challenges
  ADD CONSTRAINT ck_auth_challenges_purpose
  CHECK (purpose IN ('SESSION', 'RECOVERY'));

CREATE INDEX IF NOT EXISTS ix_auth_challenges_recovery
  ON auth_challenges (recovery_id, created_at DESC);
