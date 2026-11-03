-- ============================================================================
-- 001_init.down.sql — rollback of 001_init.sql
--
-- Destroys all loan workflow data. Run only on a database you own.
-- Tables are dropped children-first so no foreign key blocks the drop.
-- schema_migrations is bookkeeping and is left in place on purpose.
-- ============================================================================

DROP TABLE IF EXISTS auth_challenges;
DROP TABLE IF EXISTS actor_authentications;
DROP TABLE IF EXISTS workflow_sessions;
DROP TABLE IF EXISTS disbursements;
DROP TABLE IF EXISTS loan_offers;
DROP TABLE IF EXISTS credit_assessments;
DROP TABLE IF EXISTS underwriting_decisions;
DROP TABLE IF EXISTS workflow_events;
DROP TABLE IF EXISTS consents;
DROP TABLE IF EXISTS loan_applications;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS bank_accounts;
DROP TABLE IF EXISTS kyc_checks;
DROP TABLE IF EXISTS business_details;
DROP TABLE IF EXISTS employment_details;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS applicants;
