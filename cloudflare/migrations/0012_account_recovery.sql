-- Preserve the original invitation credential for account recovery.
-- Community invitations can be shared by multiple new members, so this is
-- intentionally not unique; recovery matches both nickname and code.
ALTER TABLE profiles ADD COLUMN recovery_code TEXT;
CREATE INDEX IF NOT EXISTS profiles_recovery_code_idx
  ON profiles(recovery_code);
