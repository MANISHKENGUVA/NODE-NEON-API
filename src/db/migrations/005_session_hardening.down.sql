-- Revert 005_session_hardening.sql.

DROP INDEX IF EXISTS ux_workflow_events_client_event;
ALTER TABLE workflow_events
  DROP COLUMN IF EXISTS client_event_id;

DROP INDEX IF EXISTS ix_workflow_sessions_revoked;
ALTER TABLE workflow_sessions
  DROP COLUMN IF EXISTS revoked_at;
