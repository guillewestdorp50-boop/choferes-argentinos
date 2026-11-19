ALTER TABLE profiles ADD COLUMN login_username TEXT;
ALTER TABLE profiles ADD COLUMN password_salt TEXT;
ALTER TABLE profiles ADD COLUMN password_hash TEXT;
ALTER TABLE profiles ADD COLUMN password_iterations INTEGER;
UPDATE profiles SET nickname_key=lower(trim(nickname)) WHERE nickname_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_nickname_key_unique_idx ON profiles(nickname_key) WHERE nickname_key IS NOT NULL AND id NOT LIKE 'el-viejo-%';
CREATE UNIQUE INDEX IF NOT EXISTS profiles_login_username_unique_idx ON profiles(login_username) WHERE login_username IS NOT NULL;
CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, window_started_at TEXT NOT NULL, locked_until TEXT);
