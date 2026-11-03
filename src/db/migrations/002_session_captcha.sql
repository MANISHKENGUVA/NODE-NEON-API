-- ============================================================================
-- 002_session_captcha.sql — remember that a session solved the captcha
--
-- The flow has nodes that require a captcha challenge. The browser solves it
-- once and then asks for the current state again; without this column a state
-- call cannot tell a solved captcha from an unsolved one, so the client would
-- show the captcha gate forever.
-- ============================================================================

ALTER TABLE workflow_sessions
  ADD COLUMN IF NOT EXISTS captcha_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN workflow_sessions.captcha_verified_at IS
  'When this session last solved a captcha. NULL means it has not.';
