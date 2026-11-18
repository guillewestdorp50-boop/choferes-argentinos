-- Private notices for comments removed by the community owner.
-- Comment bodies are physically deleted; only the author receives the reason.
CREATE TABLE IF NOT EXISTS comment_removal_notices (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  recipient_profile_id TEXT NOT NULL REFERENCES profiles(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS comment_removal_notices_recipient_idx
  ON comment_removal_notices(recipient_profile_id, community_id, seen_at, created_at DESC);
