-- Public profile avatars. Existing members default to the classic initials fallback.
ALTER TABLE profiles ADD COLUMN avatar_key TEXT NOT NULL DEFAULT 'truck';
