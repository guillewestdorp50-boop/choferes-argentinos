-- Preserve the original invitation credential for account recovery.
-- The code is high-entropy (10 random characters) and is only returned to the
-- authenticated account that owns it or accepted by the recovery endpoint.
ALTER TABLE profiles ADD COLUMN recovery_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_recovery_code_idx
  ON profiles(recovery_code) WHERE recovery_code IS NOT NULL;
