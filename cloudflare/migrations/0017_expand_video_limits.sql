-- Expand wall-video capacity without deleting or changing existing video metadata or posts.
-- Defer the posts.video_id foreign key while the parent table is rebuilt, then
-- re-enable checking before the migration transaction commits.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE video_media_new (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type='video/mp4'),
  byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 62914560),
  duration_seconds REAL NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 60),
  width INTEGER NOT NULL CHECK(width > 0 AND width <= 1920),
  height INTEGER NOT NULL CHECK(height > 0 AND height <= 1920),
  created_at TEXT NOT NULL
);

INSERT INTO video_media_new
  (id,community_id,profile_id,object_key,mime_type,byte_size,duration_seconds,width,height,created_at)
SELECT
  id,community_id,profile_id,object_key,mime_type,byte_size,duration_seconds,width,height,created_at
FROM video_media;

DROP TABLE video_media;
ALTER TABLE video_media_new RENAME TO video_media;

CREATE INDEX IF NOT EXISTS video_media_community_idx
  ON video_media(community_id,created_at DESC);
CREATE INDEX IF NOT EXISTS posts_video_idx ON posts(video_id);

PRAGMA defer_foreign_keys = OFF;
