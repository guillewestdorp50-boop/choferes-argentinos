SELECT
  (SELECT COUNT(*) FROM video_media) AS videos,
  (SELECT COUNT(*) FROM video_chunks) AS chunks,
  (SELECT COUNT(*) FROM video_media vm
    WHERE (SELECT COUNT(*) FROM video_chunks vc WHERE vc.video_id=vm.id)
      != CAST((vm.byte_size + 524287) / 524288 AS INTEGER)
  ) AS videos_with_incomplete_chunks,
  (SELECT COUNT(*) FROM video_chunks vc
    WHERE NOT EXISTS (SELECT 1 FROM video_media vm WHERE vm.id=vc.video_id)
  ) AS orphan_chunks,
  (SELECT COUNT(*) FROM posts WHERE video_id IS NOT NULL) AS posts_with_video,
  (SELECT COUNT(*) FROM posts p
    WHERE p.video_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM video_media vm WHERE vm.id=p.video_id)
  ) AS posts_with_missing_video,
  (SELECT COALESCE(SUM(byte_size), 0) FROM video_media) AS video_bytes_used,
  1500000000 - (SELECT COALESCE(SUM(byte_size), 0) FROM video_media) AS video_bytes_remaining,
  EXISTS(SELECT 1 FROM pragma_table_info('posts') WHERE name='is_alert') AS has_is_alert_column;