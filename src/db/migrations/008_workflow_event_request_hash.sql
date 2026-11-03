ALTER TABLE workflow_events
  ADD COLUMN request_hash TEXT;

COMMENT ON COLUMN workflow_events.request_hash IS
  'SHA-256 fingerprint of the accepted request for idempotent retry matching.';
