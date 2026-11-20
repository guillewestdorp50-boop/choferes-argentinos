-- Mark urgent PAD alerts on wall posts without changing existing posts.
ALTER TABLE posts ADD COLUMN is_alert INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS posts_alert_feed_idx ON posts(community_id,is_alert,status,deleted_at,created_at DESC);
