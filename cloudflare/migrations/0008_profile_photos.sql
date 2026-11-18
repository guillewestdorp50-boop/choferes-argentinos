-- Store each member's selected profile photo as a reference to their own uploaded media.
-- Existing avatar_key values remain as a fallback and are not changed.
ALTER TABLE profiles ADD COLUMN avatar_media_id TEXT;
