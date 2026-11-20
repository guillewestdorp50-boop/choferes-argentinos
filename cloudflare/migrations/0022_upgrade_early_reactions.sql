-- Mark posts whose early reactions were already upgraded by migration 0021.
ALTER TABLE posts ADD COLUMN reactions_upgraded_at TEXT;

UPDATE posts
SET reactions_upgraded_at = CURRENT_TIMESTAMP
WHERE datetime(COALESCE(moderated_at, created_at)) <= datetime('now', '-5 minutes');