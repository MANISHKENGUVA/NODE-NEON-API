-- ============================================================================
-- 001_init.sql — loan application workflow schema
--
-- One business entity: a loan application (loan_applications).
-- Around it: the people applying (applicants), their typed data (addresses,
-- employment, business, KYC checks, bank accounts, documents, consents), the
-- lending side (credit assessment, offer, disbursements, underwriting
-- decisions), and the append-only workflow audit trail (workflow_events).
-- ============================================================================

-- ── Migration bookkeeping ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  checksum    TEXT        NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── People ──────────────────────────────────────────────────────────────────
-- One row per natural person. The same person can be borrower on one
-- application and coborrower on another.
CREATE TABLE applicants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       TEXT,
  father_name     TEXT,
  mother_name     TEXT,
  date_of_birth   DATE,
  gender          TEXT CHECK (gender IN ('MALE', 'FEMALE', 'OTHER')),
  marital_status  TEXT CHECK (marital_status IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED', 'OTHER')),
  email           TEXT,
  mobile_number   TEXT,
  -- PAN / Aadhaar are stored as a SHA-256 hash plus the last 4 digits only.
  pan_hash        TEXT,
  pan_last4       CHAR(4),
  aadhaar_hash    TEXT,
  aadhaar_last4   CHAR(4),
  loan_purpose    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup index, deliberately not UNIQUE: one person may apply for several loans.
CREATE INDEX ix_applicants_pan_hash ON applicants (pan_hash) WHERE pan_hash IS NOT NULL;

CREATE TABLE addresses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id     UUID NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  address_type     TEXT NOT NULL DEFAULT 'CURRENT' CHECK (address_type IN ('CURRENT', 'PERMANENT')),
  flat_no          TEXT,
  building         TEXT,
  street           TEXT,
  landmark         TEXT,
  city             TEXT,
  district         TEXT,
  state            TEXT,
  pincode          TEXT,
  country          TEXT NOT NULL DEFAULT 'INDIA',
  residence_type   TEXT,
  -- Derived on the server from the presence/format of the fields above.
  is_valid         BOOLEAN NOT NULL DEFAULT false,
  pincode_verified BOOLEAN NOT NULL DEFAULT false,
  verified_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, address_type)
);

CREATE TABLE employment_details (
  applicant_id        UUID PRIMARY KEY REFERENCES applicants (id) ON DELETE CASCADE,
  employment_type     TEXT,
  employer_name       TEXT,
  designation         TEXT,
  working_since       DATE,
  is_active           BOOLEAN NOT NULL DEFAULT false,
  monthly_income      NUMERIC(14, 2) CHECK (monthly_income IS NULL OR monthly_income >= 0),
  -- Verification fields: written only by trusted services.
  employer_verified   BOOLEAN NOT NULL DEFAULT false,
  employer_blacklisted BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE business_details (
  applicant_id           UUID PRIMARY KEY REFERENCES applicants (id) ON DELETE CASCADE,
  registration_exists    BOOLEAN NOT NULL DEFAULT false,
  registration_verified  BOOLEAN NOT NULL DEFAULT false,
  registration_number    TEXT,
  annual_revenue         NUMERIC(14, 2) CHECK (annual_revenue IS NULL OR annual_revenue >= 0),
  verified_at            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kyc_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id    UUID NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  check_type      TEXT NOT NULL CHECK (check_type IN ('PAN', 'AADHAAR', 'FACE')),
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'FAILED')),
  score           NUMERIC(5, 2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  liveness_passed BOOLEAN,
  name_matched    BOOLEAN,
  mobile_linked   BOOLEAN,
  blacklisted     BOOLEAN,
  provider        TEXT,
  reference       TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, check_type)
);

CREATE TABLE bank_accounts (
  applicant_id           UUID PRIMARY KEY REFERENCES applicants (id) ON DELETE CASCADE,
  account_number_masked  TEXT,
  account_number_valid   BOOLEAN NOT NULL DEFAULT false,
  ifsc                   TEXT,
  ifsc_valid             BOOLEAN NOT NULL DEFAULT false,
  holder_name            TEXT,
  bank_name              TEXT,
  branch                 TEXT,
  verification_status    TEXT NOT NULL DEFAULT 'PENDING'
                           CHECK (verification_status IN ('PENDING', 'VERIFIED', 'FAILED')),
  verified_at            TIMESTAMPTZ,
  statement_uploaded     BOOLEAN NOT NULL DEFAULT false,
  statement_valid        BOOLEAN NOT NULL DEFAULT false,
  statement_file_url     TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- file_url + validity. is_valid stays NULL until a document check runs.
CREATE TABLE documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id UUID NOT NULL REFERENCES applicants (id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL CHECK (doc_type IN ('AADHAAR', 'PAN', 'BANK_STATEMENT', 'ADDRESS_PROOF', 'INCOME_PROOF')),
  file_url     TEXT,
  is_valid     BOOLEAN,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (applicant_id, doc_type)
);

-- ── The business entity ─────────────────────────────────────────────────────
CREATE TABLE loan_applications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_no         TEXT NOT NULL UNIQUE,
  workflow_id            TEXT NOT NULL UNIQUE,
  definition_version     TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                           CHECK (status IN ('IN_PROGRESS', 'APPROVED', 'REJECTED', 'CANCELLED')),
  current_node           TEXT NOT NULL,
  current_actor          TEXT NOT NULL,
  borrower_id            UUID REFERENCES applicants (id) ON DELETE SET NULL,
  coborrower_id          UUID REFERENCES applicants (id) ON DELETE SET NULL,
  requires_coborrower    BOOLEAN NOT NULL DEFAULT false,
  requested_amount       NUMERIC(14, 2) CHECK (requested_amount IS NULL OR requested_amount > 0),
  requested_amount_valid BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ
);

CREATE INDEX ix_loan_applications_status ON loan_applications (status, created_at DESC);
CREATE INDEX ix_loan_applications_borrower ON loan_applications (borrower_id);

CREATE TABLE consents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  consent_type   TEXT NOT NULL CHECK (consent_type IN ('BORROWER_CONSENT', 'COBORROWER_CONSENT')),
  granted        BOOLEAN NOT NULL DEFAULT false,
  granted_at     TIMESTAMPTZ,
  ip_address     INET,
  UNIQUE (application_id, consent_type)
);

-- Append-only audit trail. `sequence` is the per-application ordering key and
-- enforces idempotent, gap-free history.
CREATE TABLE workflow_events (
  id             BIGSERIAL PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  event_type     TEXT NOT NULL,
  node_key       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  from_node      TEXT,
  to_node        TEXT,
  edge_id        TEXT,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (application_id, sequence)
);

CREATE INDEX ix_workflow_events_application ON workflow_events (application_id, sequence DESC);

-- ── Lending side ────────────────────────────────────────────────────────────
CREATE TABLE underwriting_decisions (
  id              BIGSERIAL PRIMARY KEY,
  application_id  UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  decision_type   TEXT NOT NULL CHECK (decision_type IN (
                    'CREDIT_EXCEPTION', 'FRAUD_REVIEW', 'DOCUMENT_REVIEW', 'RISK_REVIEW',
                    'ELIGIBILITY_REVIEW', 'FINAL_APPROVAL', 'DISBURSEMENT_REVIEW', 'DISBURSEMENT')),
  decision        TEXT NOT NULL,
  remarks         TEXT,
  decided_by_role TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_underwriting_decisions_app
  ON underwriting_decisions (application_id, decision_type, decided_at DESC);

CREATE TABLE credit_assessments (
  application_id                UUID PRIMARY KEY REFERENCES loan_applications (id) ON DELETE CASCADE,
  credit_score                  INTEGER CHECK (credit_score IS NULL OR (credit_score BETWEEN 0 AND 1000)),
  consent_given                 BOOLEAN NOT NULL DEFAULT false,
  risk_score                    INTEGER CHECK (risk_score IS NULL OR (risk_score BETWEEN 0 AND 100)),
  fraud_status                  TEXT NOT NULL DEFAULT 'PENDING'
                                  CHECK (fraud_status IN ('PENDING', 'CLEAR', 'REVIEW', 'CONFIRMED')),
  eligibility_status            TEXT NOT NULL DEFAULT 'PENDING'
                                  CHECK (eligibility_status IN ('PENDING', 'ELIGIBLE', 'EXCEPTION', 'INELIGIBLE')),
  document_verification_status  TEXT NOT NULL DEFAULT 'PENDING'
                                  CHECK (document_verification_status IN ('PENDING', 'VERIFIED', 'REVIEW', 'FAILED')),
  assessed_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loan_offers (
  application_id           UUID PRIMARY KEY REFERENCES loan_applications (id) ON DELETE CASCADE,
  interest_rate            NUMERIC(6, 3) CHECK (interest_rate IS NULL OR interest_rate >= 0),
  interest_rate_calculated BOOLEAN NOT NULL DEFAULT false,
  borrower_accepted        BOOLEAN NOT NULL DEFAULT false,
  accepted_at              TIMESTAMPTZ,
  agreement_generated      BOOLEAN NOT NULL DEFAULT false,
  agreement_generated_at   TIMESTAMPTZ,
  esign_status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (esign_status IN ('PENDING', 'SIGNED', 'FAILED')),
  mandate_status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (mandate_status IN ('PENDING', 'ACTIVE', 'FAILED')),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disbursements (
  id                 BIGSERIAL PRIMARY KEY,
  application_id     UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  status             TEXT NOT NULL CHECK (status IN ('REQUESTED', 'COMPLETED', 'FAILED')),
  request_status     TEXT NOT NULL DEFAULT 'PENDING',
  retry_allowed      BOOLEAN NOT NULL DEFAULT false,
  amount             NUMERIC(14, 2) CHECK (amount IS NULL OR amount > 0),
  provider_reference TEXT,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_disbursements_app ON disbursements (application_id, created_at DESC);

-- ── Sessions and authentication ─────────────────────────────────────────────
CREATE TABLE workflow_sessions (
  session_id     TEXT PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES loan_applications (id) ON DELETE CASCADE,
  workflow_actor TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ANONYMOUS' CHECK (status IN ('ANONYMOUS', 'ACTOR_AUTHENTICATED')),
  actor_id       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_workflow_sessions_application ON workflow_sessions (application_id);

CREATE TABLE actor_authentications (
  auth_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL REFERENCES workflow_sessions (session_id) ON DELETE CASCADE,
  actor_id     TEXT NOT NULL,
  method       TEXT NOT NULL,
  subject_hash TEXT,
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED'))
);

CREATE INDEX ix_actor_authentications_session
  ON actor_authentications (session_id, verified_at DESC);

CREATE TABLE auth_challenges (
  challenge_id UUID PRIMARY KEY,
  session_id   TEXT REFERENCES workflow_sessions (session_id) ON DELETE CASCADE,
  method       TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX ix_auth_challenges_session ON auth_challenges (session_id, created_at DESC);
