CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  nickname TEXT NOT NULL CHECK(length(nickname) BETWEEN 2 AND 32),
  bio TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','moderator','member')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_community_idx ON profiles(community_id, nickname);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_profile_idx ON devices(profile_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  code_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('community','friend','device')),
  created_by_profile_id TEXT REFERENCES profiles(id),
  target_profile_id TEXT REFERENCES profiles(id),
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_code_idx ON invites(code_hash, expires_at);

CREATE TABLE IF NOT EXISTS friend_links (
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  friend_profile_id TEXT NOT NULL REFERENCES profiles(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, friend_profile_id),
  CHECK(profile_id <> friend_profile_id)
);
CREATE INDEX IF NOT EXISTS friend_links_friend_idx ON friend_links(friend_profile_id);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png','image/webp')),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_community_idx ON media(community_id, created_at);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL DEFAULT '',
  media_id TEXT REFERENCES media(id),
  created_at TEXT NOT NULL,
  CHECK(length(body) <= 2000)
);
CREATE INDEX IF NOT EXISTS posts_community_created_idx ON posts(community_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_profile_idx ON posts(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_post_idx ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS reactions (
  post_id TEXT NOT NULL REFERENCES posts(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  reaction TEXT NOT NULL DEFAULT 'like' CHECK(reaction IN ('like')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(post_id, profile_id, reaction)
);
CREATE INDEX IF NOT EXISTS reactions_profile_idx ON reactions(profile_id, post_id);

CREATE TABLE IF NOT EXISTS route_status (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id),
  community_id TEXT NOT NULL REFERENCES communities(id),
  status TEXT NOT NULL CHECK(status IN ('libre','cargando','cargado','descargando')),
  location_label TEXT,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_status_community_expiry_idx ON route_status(community_id, expires_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS route_alerts (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL CHECK(kind IN ('accidente','demora','corte','clima','ruta','otro')),
  road TEXT,
  location_label TEXT,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS route_alerts_community_expiry_idx ON route_alerts(community_id, expires_at, created_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id),
  sender_profile_id TEXT NOT NULL REFERENCES profiles(id),
  recipient_profile_id TEXT NOT NULL REFERENCES profiles(id),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  read_at TEXT,
  CHECK(sender_profile_id <> recipient_profile_id)
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(community_id, sender_profile_id, recipient_profile_id, created_at);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages(recipient_profile_id, read_at, created_at DESC);
