-- Keep one durable wall status per driver and allow authors to remove their PAD alerts.
ALTER TABLE route_status ADD COLUMN wall_post_id TEXT REFERENCES posts(id);
ALTER TABLE driver_activity ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS driver_activity_deleted_idx ON driver_activity(community_id,deleted_at,status,created_at DESC);
