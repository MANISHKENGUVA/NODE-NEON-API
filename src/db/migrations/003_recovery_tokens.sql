-- ============================================================================
-- 003_recovery_tokens.sql — a credential that outlives a browser session
--
-- The workflow session lives 12 h and disappears when the browser drops it.
-- This table holds a longer-lived, revocable credential that lets the same
-- browser resume the SAME application instead of silently creating a second
-- one when the URL still names an existing workflow.
--
-- Only the SHA-256 digest is stored. The raw token exists once, in an HttpOnly
-- cookie. A workflow id is never accepted as a credential by itself.
-- ============================================================================

CREATE TABLE application_recovery_tokens (
  token_hash     TEXT PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  workflow_actor TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ
);

CREATE INDEX ix_recovery_tokens_application
  ON application_recovery_tokens (application_id);

COMMENT ON TABLE application_recovery_tokens IS
  'Long-lived resume credentials. Digests only; revoked or expired rows are refused.';
