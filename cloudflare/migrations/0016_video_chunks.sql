-- Store MP4 binaries in small D1 rows so uploads do not require a KV API token.
CREATE TABLE IF NOT EXISTS video_chunks (
  video_id TEXT NOT NULL REFERENCES video_media(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 524288),
  PRIMARY KEY(video_id,chunk_index)
);
