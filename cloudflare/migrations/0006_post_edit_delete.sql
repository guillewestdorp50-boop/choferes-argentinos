-- Soft-delete keeps reactions/comments intact while removing a post from public feeds.
ALTER TABLE posts ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS posts_deleted_idx ON posts(community_id,deleted_at,status,created_at);
