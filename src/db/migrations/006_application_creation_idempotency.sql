CREATE TABLE application_creation_idempotency (
  key_hash            TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  application_id      UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  session_id          TEXT REFERENCES workflow_sessions (session_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE application_creation_idempotency IS
  'Hashed idempotency keys prevent retries from creating duplicate loan applications.';
