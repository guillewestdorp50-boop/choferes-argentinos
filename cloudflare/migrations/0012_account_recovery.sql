-- Keep the original invitation code and a salted PIN verifier for DATOS.
ALTER TABLE profiles ADD COLUMN recovery_code TEXT;
ALTER TABLE profiles ADD COLUMN recovery_pin_salt TEXT;
ALTER TABLE profiles ADD COLUMN recovery_pin_hash TEXT;
CREATE INDEX IF NOT EXISTS profiles_recovery_code_idx ON profiles(recovery_code);
