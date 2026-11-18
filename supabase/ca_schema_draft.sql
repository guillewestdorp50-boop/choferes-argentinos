-- DRAFT ONLY — do not apply to the shared production Supabase project yet.
-- Choferes Argentinos isolated schema: all objects use the ca_ prefix.
-- The Worker remains the only application entry point. It must authenticate the
-- existing 64-character device bearer token, hash it, resolve ca_devices/ca_profiles,
-- and enforce community/ownership/role checks before every operation.
-- Never expose a Supabase service_role/secret key to the PWA.
-- RLS is enabled and client roles receive no table privileges. The server-side
-- Worker credential is the only role granted table access and bypasses RLS.

CREATE TABLE public.ca_communities (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE public.ca_profiles (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  nickname text NOT NULL CHECK (length(nickname) BETWEEN 2 AND 32),
  bio text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','moderator','member')),
  avatar_key text NOT NULL DEFAULT 'truck',
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX ca_profiles_community_idx ON public.ca_profiles(community_id, nickname);

CREATE TABLE public.ca_devices (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  token_hash text NOT NULL UNIQUE,
  created_at text NOT NULL,
  last_seen_at text NOT NULL,
  revoked_at text
);
CREATE INDEX ca_devices_profile_idx ON public.ca_devices(profile_id);

CREATE TABLE public.ca_invites (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  code_hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('community','friend','device')),
  created_by_profile_id text REFERENCES public.ca_profiles(id),
  target_profile_id text REFERENCES public.ca_profiles(id),
  max_uses integer NOT NULL DEFAULT 1,
  uses integer NOT NULL DEFAULT 0,
  expires_at text NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX ca_invites_code_idx ON public.ca_invites(code_hash, expires_at);

CREATE TABLE public.ca_friend_links (
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  friend_profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  created_at text NOT NULL,
  PRIMARY KEY (profile_id, friend_profile_id),
  CHECK (profile_id <> friend_profile_id)
);
CREATE INDEX ca_friend_links_friend_idx ON public.ca_friend_links(friend_profile_id);

CREATE TABLE public.ca_media (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp')),
  data bytea NOT NULL,
  created_at text NOT NULL
);
CREATE INDEX ca_media_community_idx ON public.ca_media(community_id, created_at);

CREATE TABLE public.ca_posts (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 2000),
  media_id text REFERENCES public.ca_media(id),
  created_at text NOT NULL,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected')),
  moderated_by_profile_id text REFERENCES public.ca_profiles(id),
  moderated_at text,
  deleted_at text
);
CREATE INDEX ca_posts_community_created_idx ON public.ca_posts(community_id, created_at DESC);
CREATE INDEX ca_posts_profile_idx ON public.ca_posts(profile_id, created_at DESC);
CREATE INDEX ca_posts_moderation_idx ON public.ca_posts(community_id, status, created_at);
CREATE INDEX ca_posts_deleted_idx ON public.ca_posts(community_id, deleted_at, status, created_at);

CREATE TABLE public.ca_comments (
  id text PRIMARY KEY,
  post_id text NOT NULL REFERENCES public.ca_posts(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at text NOT NULL
);
CREATE INDEX ca_comments_post_idx ON public.ca_comments(post_id, created_at);

CREATE TABLE public.ca_reactions (
  post_id text NOT NULL REFERENCES public.ca_posts(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  reaction text NOT NULL DEFAULT 'like' CHECK (reaction IN ('like')),
  created_at text NOT NULL,
  PRIMARY KEY (post_id, profile_id, reaction)
);
CREATE INDEX ca_reactions_profile_idx ON public.ca_reactions(profile_id, post_id);

CREATE TABLE public.ca_route_status (
  profile_id text PRIMARY KEY REFERENCES public.ca_profiles(id),
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  status text NOT NULL CHECK (status IN (
    'libre','cargando','cargado','descargando','demorado','accidente',
    'deposito','planta','base','casa','descansando','cafe','ypf','repostando'
  )),
  location_label text,
  note text NOT NULL DEFAULT '',
  updated_at text NOT NULL,
  expires_at text NOT NULL
);
CREATE INDEX ca_route_status_community_expiry_idx
  ON public.ca_route_status(community_id, expires_at, updated_at DESC);

CREATE TABLE public.ca_route_alerts (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  kind text NOT NULL CHECK (kind IN ('accidente','demora','corte','clima','ruta','otro')),
  road text,
  location_label text,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
  created_at text NOT NULL,
  expires_at text NOT NULL
);
CREATE INDEX ca_route_alerts_community_expiry_idx
  ON public.ca_route_alerts(community_id, expires_at, created_at DESC);

CREATE TABLE public.ca_messages (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  sender_profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  recipient_profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at text NOT NULL,
  read_at text,
  CHECK (sender_profile_id <> recipient_profile_id)
);
CREATE INDEX ca_messages_conversation_idx
  ON public.ca_messages(community_id, sender_profile_id, recipient_profile_id, created_at);
CREATE INDEX ca_messages_recipient_idx
  ON public.ca_messages(recipient_profile_id, read_at, created_at DESC);

CREATE TABLE public.ca_push_subscriptions (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX ca_push_subscriptions_profile_idx ON public.ca_push_subscriptions(profile_id);

CREATE TABLE public.ca_badge_awards (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  badge_key text NOT NULL,
  level text NOT NULL CHECK (level IN ('Bronce','Plata','Oro','Platino','Diamante')),
  awarded_by_profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  awarded_at text NOT NULL,
  UNIQUE (profile_id, badge_key)
);
CREATE INDEX ca_badge_awards_community_profile_idx
  ON public.ca_badge_awards(community_id, profile_id, awarded_at DESC);

CREATE TABLE public.ca_driver_activity (
  id text PRIMARY KEY,
  community_id text NOT NULL REFERENCES public.ca_communities(id),
  profile_id text NOT NULL REFERENCES public.ca_profiles(id),
  kind text NOT NULL CHECK (kind IN (
    'libre','cargando','cargado','descargando','demorado','accidente',
    'deposito','planta','base','casa','descansando','cafe','ypf','repostando','otro'
  )),
  location_label text,
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 1200),
  media_id text REFERENCES public.ca_media(id),
  audio_mime_type text CHECK (audio_mime_type IS NULL OR audio_mime_type IN (
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/aac'
  )),
  audio_data bytea,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at text NOT NULL,
  moderated_by_profile_id text REFERENCES public.ca_profiles(id),
  moderated_at text,
  rejection_reason text,
  CHECK (length(COALESCE(location_label,'')) <= 160),
  CHECK (
    (audio_mime_type IS NULL AND audio_data IS NULL) OR
    (audio_mime_type IS NOT NULL AND audio_data IS NOT NULL)
  )
);
CREATE INDEX ca_driver_activity_community_status_created_idx
  ON public.ca_driver_activity(community_id, status, created_at DESC);
CREATE INDEX ca_driver_activity_profile_created_idx
  ON public.ca_driver_activity(profile_id, created_at DESC);

-- No direct PWA/browser access. Keep these tables inaccessible to anon/authenticated.
REVOKE ALL ON TABLE
  public.ca_communities, public.ca_profiles, public.ca_devices, public.ca_invites,
  public.ca_friend_links, public.ca_media, public.ca_posts, public.ca_comments,
  public.ca_reactions, public.ca_route_status, public.ca_route_alerts,
  public.ca_messages, public.ca_push_subscriptions, public.ca_badge_awards,
  public.ca_driver_activity
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.ca_communities, public.ca_profiles, public.ca_devices, public.ca_invites,
  public.ca_friend_links, public.ca_media, public.ca_posts, public.ca_comments,
  public.ca_reactions, public.ca_route_status, public.ca_route_alerts,
  public.ca_messages, public.ca_push_subscriptions, public.ca_badge_awards,
  public.ca_driver_activity
TO service_role;

ALTER TABLE public.ca_communities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_friend_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_route_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_route_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_badge_awards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_driver_activity ENABLE ROW LEVEL SECURITY;

-- Before production use: implement and test a Worker data adapter for every route,
-- verify device-token auth/authorization, and migrate data only after a verified
-- D1 export + row-count/checksum comparison. Do not delete or disable D1 yet.
