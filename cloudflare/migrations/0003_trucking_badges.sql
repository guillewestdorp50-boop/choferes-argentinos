-- Trucking-themed merit badges. One current level per badge category and profile.
CREATE TABLE IF NOT EXISTS badge_awards (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  badge_key TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('Bronce','Plata','Oro','Platino','Diamante')),
  awarded_by_profile_id TEXT NOT NULL REFERENCES profiles(id),
  awarded_at TEXT NOT NULL,
  UNIQUE(profile_id,badge_key)
);
CREATE INDEX IF NOT EXISTS badge_awards_community_profile_idx
  ON badge_awards(community_id,profile_id,awarded_at DESC);
