-- Optional descriptions for route status posts are moderated separately.
-- Approving/rejecting a description never changes the original post's moderation status.
CREATE TABLE IF NOT EXISTS route_status_descriptions (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  post_id TEXT NOT NULL REFERENCES posts(id),
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 500),
  media_id TEXT REFERENCES media(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  moderated_by_profile_id TEXT REFERENCES profiles(id),
  moderated_at TEXT,
  rejection_reason TEXT,
  CHECK(length(body) > 0 OR media_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS route_status_descriptions_post_idx
  ON route_status_descriptions(post_id);
CREATE INDEX IF NOT EXISTS route_status_descriptions_queue_idx
  ON route_status_descriptions(community_id,status,created_at);
