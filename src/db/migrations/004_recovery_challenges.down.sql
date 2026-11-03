-- ============================================================================
-- 004_recovery_challenges.down.sql — rollback of 004_recovery_challenges.sql
-- ============================================================================

DROP INDEX IF EXISTS ix_auth_challenges_recovery;

ALTER TABLE auth_challenges
  DROP CONSTRAINT IF EXISTS ck_auth_challenges_purpose,
  DROP COLUMN IF EXISTS purpose,
  DROP COLUMN IF EXISTS recovery_id;

DROP TABLE IF EXISTS workflow_recovery_challenges;
