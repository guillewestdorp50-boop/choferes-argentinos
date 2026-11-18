-- Account recovery: retain the original invitation and a salted PIN verifier.
ALTER TABLE profiles ADD COLUMN recovery_code TEXT;
ALTER TABLE profiles ADD COLUMN recovery_pin_salt TEXT;
ALTER TABLE profiles ADD COLUMN recovery_pin_hash TEXT;
ALTER TABLE invites ADD COLUMN used_by_profile_id TEXT;
CREATE INDEX IF NOT EXISTS profiles_recovery_code_idx ON profiles(recovery_code);
CREATE INDEX IF NOT EXISTS invites_used_by_profile_idx ON invites(used_by_profile_id);
