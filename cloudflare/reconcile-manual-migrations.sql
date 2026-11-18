-- Reconcile only migrations whose complete schema changes already exist.
-- This changes migration bookkeeping only; it does not alter application data.
INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0009_pad_conversations.sql'
WHERE EXISTS (SELECT 1 FROM pragma_table_info('posts') WHERE name = 'source_activity_id')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'posts_source_activity_idx')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_reactions')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'activity_reactions_profile_idx')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_comments')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'activity_comments_thread_idx');

INSERT OR IGNORE INTO d1_migrations (name)
SELECT '0010_comment_moderation.sql'
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comment_removal_notices')
  AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'comment_removal_notices_recipient_idx');
