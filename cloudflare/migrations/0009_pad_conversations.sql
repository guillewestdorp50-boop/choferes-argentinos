-- Keep PAD reactions and conversations attached to each verified report.
ALTER TABLE posts ADD COLUMN source_activity_id TEXT REFERENCES driver_activity(id);
CREATE UNIQUE INDEX IF NOT EXISTS posts_source_activity_idx
  ON posts(source_activity_id) WHERE source_activity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity_reactions (
  activity_id TEXT NOT NULL REFERENCES driver_activity(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(activity_id, profile_id)
);
CREATE INDEX IF NOT EXISTS activity_reactions_profile_idx
  ON activity_reactions(profile_id, activity_id);

CREATE TABLE IF NOT EXISTS activity_comments (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES driver_activity(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_comments_thread_idx
  ON activity_comments(activity_id, created_at);
