-- Preserve current weighted totals and all existing reaction ownership.
ALTER TABLE posts ADD COLUMN reaction_score INTEGER NOT NULL DEFAULT 0;

UPDATE posts
SET reaction_score = (
  SELECT COUNT(*) * CASE
    WHEN datetime(COALESCE(posts.moderated_at, posts.created_at)) <= datetime('now', '-5 minutes') THEN 5
    ELSE 1
  END
  FROM reactions
  WHERE reactions.post_id = posts.id
);

DROP INDEX IF EXISTS reactions_profile_idx;
ALTER TABLE reactions RENAME TO reactions_legacy;

CREATE TABLE reactions (
  post_id TEXT NOT NULL REFERENCES posts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  reaction TEXT NOT NULL DEFAULT 'like'
    CHECK(reaction IN ('like','thumbs_up','laugh','sad','angry')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id, profile_id)
);

INSERT INTO reactions(post_id, profile_id, reaction, created_at)
SELECT post_id, profile_id, reaction, created_at FROM reactions_legacy;

DROP TABLE reactions_legacy;
CREATE INDEX reactions_profile_idx ON reactions(profile_id, post_id);
