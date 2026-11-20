-- Correct existing aggregate totals: only heart reactions receive the server's four-like gift.
-- Other reaction types remain one unit each in the general likes total.
UPDATE posts
SET reaction_score = MAX(
  0,
  COALESCE(reaction_score, 0) - 4 * (
    SELECT COUNT(*)
    FROM reactions r
    WHERE r.post_id = posts.id
      AND r.reaction <> 'like'
  )
);
