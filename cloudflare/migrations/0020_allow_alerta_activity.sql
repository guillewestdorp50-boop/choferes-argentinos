-- Allow the urgent ALERTA PAD kind while preserving all existing reports and references.
-- Defer child-table foreign keys during the table swap; restore enforcement before commit.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE driver_activity_new (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL CHECK(kind IN (
    'libre','cargando','cargado','descargando','demorado','accidente','alerta',
    'deposito','planta','base','casa','descansando','cafe','ypf','repostando','otro'
  )),
  location_label TEXT,
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 1200),
  media_id TEXT REFERENCES media(id),
  audio_mime_type TEXT CHECK(audio_mime_type IS NULL OR audio_mime_type IN ('audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac')),
  audio_data BLOB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  moderated_by_profile_id TEXT REFERENCES profiles(id),
  moderated_at TEXT,
  rejection_reason TEXT,
  deleted_at TEXT,
  CHECK(length(COALESCE(location_label,'')) <= 160),
  CHECK((audio_mime_type IS NULL AND audio_data IS NULL) OR (audio_mime_type IS NOT NULL AND audio_data IS NOT NULL))
);

INSERT INTO driver_activity_new (
  id,community_id,profile_id,kind,location_label,body,media_id,audio_mime_type,audio_data,
  status,created_at,moderated_by_profile_id,moderated_at,rejection_reason,deleted_at
)
SELECT
  id,community_id,profile_id,kind,location_label,body,media_id,audio_mime_type,audio_data,
  status,created_at,moderated_by_profile_id,moderated_at,rejection_reason,deleted_at
FROM driver_activity;

DROP TABLE driver_activity;
ALTER TABLE driver_activity_new RENAME TO driver_activity;

CREATE INDEX driver_activity_community_status_created_idx
  ON driver_activity(community_id, status, created_at DESC);
CREATE INDEX driver_activity_profile_created_idx
  ON driver_activity(profile_id, created_at DESC);
CREATE INDEX driver_activity_deleted_idx
  ON driver_activity(community_id,deleted_at,status,created_at DESC);

PRAGMA defer_foreign_keys = OFF;
