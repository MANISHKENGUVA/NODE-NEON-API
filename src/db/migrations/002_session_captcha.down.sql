-- ============================================================================
-- 002_session_captcha.down.sql — rollback of 002_session_captcha.sql
-- ============================================================================

ALTER TABLE workflow_sessions
  DROP COLUMN IF EXISTS captcha_verified_at;
