-- ============================================================================
-- 005_session_hardening.sql — revocation and idempotent client events
--
-- Two independent hardening measures:
--
--   workflow_sessions.revoked_at
--     A session can be ended by the client (logout / "start over") instead of
--     waiting for the 30-minute TTL. A revoked row is refused even if it has
--     not expired. The column is nullable so existing rows stay valid.
--
--   workflow_events.client_event_id
--     A client may attach an idempotency key to a step submission. A retry
--     that reuses the key is a no-op, not a second transition. The partial
--     unique index enforces this per application without affecting events
--     that do not carry a key.
-- ============================================================================

ALTER TABLE workflow_sessions
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_workflow_sessions_revoked
  ON workflow_sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;

COMMENT ON COLUMN workflow_sessions.revoked_at IS
  'When this session was explicitly revoked. NULL means it is not revoked.';

ALTER TABLE workflow_events
  ADD COLUMN IF NOT EXISTS client_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workflow_events_client_event
  ON workflow_events (application_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

COMMENT ON COLUMN workflow_events.client_event_id IS
  'Optional client-supplied idempotency key, unique per application.';
