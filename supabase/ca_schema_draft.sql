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


-- Draft-only RPC bridge. It runs only as the server-side service_role and accepts
-- parameter values separately from SQL text. Browser roles cannot execute it.
-- The Worker translates its fixed D1 query strings to ca_* table names first.
CREATE OR REPLACE FUNCTION public.ca_worker_query(p_sql text, p_params jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_sql text := p_sql;
  v_pos integer;
  v_index integer := 0;
  v_param jsonb;
  v_literal text;
  v_row record;
  v_match text[];
  v_table text;
  v_rows jsonb := '[]'::jsonb;
  v_changes bigint := 0;
  v_param_count integer := COALESCE(jsonb_array_length(p_params), 0);
BEGIN
  IF p_sql IS NULL OR length(p_sql) > 12000
     OR position(';' IN p_sql) > 0
     OR position('--' IN p_sql) > 0
     OR position('/*' IN p_sql) > 0
     OR position('*/' IN p_sql) > 0 THEN
    RAISE EXCEPTION 'Consulta no permitida';
  END IF;

  IF upper(left(ltrim(p_sql), 6)) NOT IN ('SELECT','INSERT','UPDATE','DELETE') THEN
    RAISE EXCEPTION 'Tipo de consulta no permitido';
  END IF;

  IF p_sql !~* '\mca_(communities|profiles|devices|invites|friend_links|media|posts|comments|reactions|route_status|route_alerts|messages|push_subscriptions|badge_awards|driver_activity)\M'
     OR p_sql ~* '\m(multiplayer_[a-z0-9_]*|ilox_[a-z0-9_]*)\M' THEN
    RAISE EXCEPTION 'La consulta debe limitarse a las tablas de Choferes Argentinos';
  END IF;

  -- Reject every referenced table outside the explicit CA allowlist. This prevents
  -- this RPC from being used to query or mutate ILOX or unrelated application data.
  FOR v_match IN
    SELECT regexp_matches(p_sql, '\m(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)', 'gi')
  LOOP
    v_table := lower(v_match[1]);
    IF v_table NOT IN (
      'ca_communities','ca_profiles','ca_devices','ca_invites','ca_friend_links',
      'ca_media','ca_posts','ca_comments','ca_reactions','ca_route_status',
      'ca_route_alerts','ca_messages','ca_push_subscriptions','ca_badge_awards',
      'ca_driver_activity'
    ) THEN
      RAISE EXCEPTION 'La consulta intentó acceder a una tabla ajena a Choferes Argentinos';
    END IF;
  END LOOP;

  -- Substitute only positional placeholders, quoting every JSON value as a SQL
  -- literal. This avoids treating user-supplied values as executable SQL.
  LOOP
    v_pos := position('?' IN v_sql);
    EXIT WHEN v_pos = 0;
    v_index := v_index + 1;
    IF v_index > v_param_count THEN
      RAISE EXCEPTION 'Faltan parámetros para la consulta';
    END IF;
    v_param := p_params -> (v_index - 1);
    IF v_param = 'null'::jsonb THEN
      v_literal := 'NULL';
    ELSE
      v_literal := quote_literal(p_params ->> (v_index - 1));
    END IF;
    v_sql := overlay(v_sql placing v_literal from v_pos for 1);
  END LOOP;

  IF v_index <> v_param_count THEN
    RAISE EXCEPTION 'Cantidad de parámetros incorrecta';
  END IF;

  IF upper(left(ltrim(v_sql), 6)) = 'SELECT' THEN
    FOR v_row IN EXECUTE v_sql LOOP
      v_rows := v_rows || jsonb_build_array(to_jsonb(v_row));
    END LOOP;
    RETURN jsonb_build_object('success', true, 'results', v_rows);
  END IF;

  EXECUTE v_sql;
  GET DIAGNOSTICS v_changes = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'changes', v_changes);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ca_worker_batch(p_operations jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_operation jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_operations) <> 'array' OR jsonb_array_length(p_operations) > 20 THEN
    RAISE EXCEPTION 'Lote no válido';
  END IF;
  FOR v_operation IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
    v_results := v_results || jsonb_build_array(
      public.ca_worker_query(v_operation ->> 'sql', COALESCE(v_operation -> 'params', '[]'::jsonb))
    );
  END LOOP;
  RETURN v_results;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_worker_query(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ca_worker_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_worker_query(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ca_worker_batch(jsonb) TO service_role;

-- These functions are intentionally not installed until the schema and adapter
-- have passed isolated Postgres integration tests. Never expose the server key.
