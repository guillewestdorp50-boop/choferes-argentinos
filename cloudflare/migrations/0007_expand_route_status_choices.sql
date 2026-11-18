-- Expand the persisted route status choices without losing existing driver statuses.
-- The initial schema allowed only the original four values, while the Worker and
-- PWA already support the full set of fourteen.
CREATE TABLE route_status_rebuild (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  status TEXT NOT NULL CHECK(status IN (
    'libre','cargando','cargado','descargando','demorado','accidente',
    'deposito','planta','base','casa','descansando','cafe','ypf','repostando'
  )),
  location_label TEXT,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT INTO route_status_rebuild
  (profile_id,community_id,status,location_label,note,updated_at,expires_at)
SELECT profile_id,community_id,status,location_label,note,updated_at,expires_at
FROM route_status;

DROP TABLE route_status;
ALTER TABLE route_status_rebuild RENAME TO route_status;

CREATE INDEX IF NOT EXISTS route_status_community_expiry_idx
  ON route_status(community_id,expires_at,updated_at DESC);
