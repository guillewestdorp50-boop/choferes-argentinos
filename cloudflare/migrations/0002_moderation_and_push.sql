-- Existing posts remain visible; new member posts require owner/moderator approval.
ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
  CHECK(status IN ('pending','approved','rejected'));
ALTER TABLE posts ADD COLUMN moderated_by_profile_id TEXT REFERENCES profiles(id);
ALTER TABLE posts ADD COLUMN moderated_at TEXT;

CREATE INDEX IF NOT EXISTS posts_moderation_idx
  ON posts(community_id,status,created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_profile_idx
  ON push_subscriptions(profile_id);
