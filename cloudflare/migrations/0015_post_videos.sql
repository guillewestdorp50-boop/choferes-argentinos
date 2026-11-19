-- Short MP4 videos for community wall posts. Video bytes are stored in private Workers KV.
CREATE TABLE IF NOT EXISTS video_media (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type='video/mp4'),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 15728640),
  duration_seconds REAL NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 15.25),
  width INTEGER NOT NULL CHECK(width > 0 AND width <= 1280),
  height INTEGER NOT NULL CHECK(height > 0 AND height <= 1280),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_media_community_idx ON video_media(community_id,created_at DESC);
ALTER TABLE posts ADD COLUMN video_id TEXT REFERENCES video_media(id);
CREATE INDEX IF NOT EXISTS posts_video_idx ON posts(video_id);
