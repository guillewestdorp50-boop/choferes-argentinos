-- Isolated PostgreSQL integration test for ca_schema_draft.sql.
-- Run only against a disposable PostgreSQL 16 instance, never production.
DO $check_schema$
DECLARE
  v_tables integer;
  v_unprotected integer;
BEGIN
  SELECT count(*) INTO v_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'ca\_%' ESCAPE '\';
  IF v_tables <> 15 THEN
    RAISE EXCEPTION 'Se esperaban 15 tablas ca_; se encontraron %', v_tables;
  END IF;

  SELECT count(*) INTO v_unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND c.relname LIKE 'ca\_%' ESCAPE '\'
    AND NOT c.relrowsecurity;
  IF v_unprotected <> 0 THEN
    RAISE EXCEPTION 'Hay tablas ca_ sin RLS: %', v_unprotected;
  END IF;
END;
$check_schema$;

SET ROLE service_role;

DO $exercise$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.ca_worker_query(
    'INSERT INTO ca_communities(id,name,created_at) VALUES(?,?,?)',
    '["community-1","Comunidad de prueba","2026-11-18T00:00:00Z"]'::jsonb
  );

  PERFORM public.ca_worker_query(
    'INSERT INTO ca_profiles(id,community_id,nickname,role,created_at,updated_at) VALUES(?,?,?,''owner'',?,?)',
    '["profile-1","community-1","Chofer Uno","2026-11-18T00:00:00Z","2026-11-18T00:00:00Z"]'::jsonb
  );
  PERFORM public.ca_worker_query(
    'INSERT INTO ca_profiles(id,community_id,nickname,role,created_at,updated_at) VALUES(?,?,?,''member'',?,?)',
    '["profile-2","community-1","Chofer Dos","2026-11-18T00:00:00Z","2026-11-18T00:00:00Z"]'::jsonb
  );
  PERFORM public.ca_worker_query(
    'INSERT INTO ca_profiles(id,community_id,nickname,role,created_at,updated_at) VALUES(?,?,?,''member'',?,?)',
    '["profile-3","community-1","Chofer Tres","2026-11-18T00:00:00Z","2026-11-18T00:00:00Z"]'::jsonb
  );

  -- Confirm expanded route states survive PostgreSQL checks.
  PERFORM public.ca_worker_query(
    'INSERT INTO ca_route_status(profile_id,community_id,status,location_label,note,updated_at,expires_at) VALUES(?,? ,''ypf'',?,?,?,?)',
    '["profile-1","community-1","Ruta 9","Parada de prueba","2026-11-18T00:00:00Z","2026-11-19T00:00:00Z"]'::jsonb
  );

  -- D1 batch compatibility and atomicity.
  PERFORM public.ca_worker_batch(
    '[
      {"sql":"INSERT INTO ca_friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)","params":["profile-1","profile-2","t1"]},
      {"sql":"INSERT INTO ca_friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)","params":["profile-2","profile-1","t1"]}
    ]'::jsonb
  );
  v_result := public.ca_worker_query(
    'SELECT COUNT(*) AS total FROM ca_friend_links WHERE profile_id=?',
    '["profile-1"]'::jsonb
  );
  IF v_result->'results'->0->>'total' <> '1' THEN
    RAISE EXCEPTION 'El lote de amistades no persistió correctamente: %', v_result;
  END IF;

  BEGIN
    BEGIN
      PERFORM public.ca_worker_batch(
        '[
          {"sql":"INSERT INTO ca_friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)","params":["profile-1","profile-3","t2"]},
          {"sql":"INSERT INTO ca_friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)","params":["profile-2","profile-inexistente","t2"]}
        ]'::jsonb
      );
      RAISE EXCEPTION 'El lote inválido debería haber fallado';
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
    IF EXISTS (
      SELECT 1 FROM ca_friend_links
      WHERE profile_id='profile-1' AND friend_profile_id='profile-3'
    ) THEN
      RAISE EXCEPTION 'El lote fallido dejó una escritura parcial';
    END IF;
  END;

  -- Binary upload/download compatibility.
  PERFORM public.ca_worker_query(
    'INSERT INTO ca_media(id,community_id,profile_id,mime_type,data,created_at) VALUES(?,?,?,?,?::bytea,?)',
    '["media-1","community-1","profile-1","image/png","\\x4142","2026-11-18T00:00:00Z"]'::jsonb
  );
  v_result := public.ca_worker_query(
    'SELECT mime_type,data,length(data) AS byte_length FROM ca_media WHERE id=? AND community_id=?',
    '["media-1","community-1"]'::jsonb
  );
  IF v_result->'results'->0->>'byte_length' <> '2' THEN
    RAISE EXCEPTION 'El binario no se conservó: %', v_result;
  END IF;

  -- A query cannot escape the explicit ca_* table allowlist.
  BEGIN
    PERFORM public.ca_worker_query(
      'SELECT ca_profiles.id FROM ca_profiles JOIN pg_class ON true',
      '[]'::jsonb
    );
    RAISE EXCEPTION 'El RPC aceptó una tabla fuera de la lista permitida';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'La consulta intentó acceder a una tabla ajena a Choferes Argentinos' THEN
      RAISE;
    END IF;
  END;
END;
$exercise$;

RESET ROLE;

DO $permissions$
BEGIN
  IF has_function_privilege('anon','public.ca_worker_query(text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'anon puede ejecutar ca_worker_query';
  END IF;
  IF has_function_privilege('authenticated','public.ca_worker_batch(jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated puede ejecutar ca_worker_batch';
  END IF;
  IF has_table_privilege('anon','public.ca_profiles','SELECT') THEN
    RAISE EXCEPTION 'anon puede leer ca_profiles';
  END IF;
  IF has_table_privilege('authenticated','public.ca_messages','SELECT') THEN
    RAISE EXCEPTION 'authenticated puede leer ca_messages';
  END IF;
END;
$permissions$;

SELECT 'OK: esquema, RLS, permisos, RPC, lotes atómicos y bytea verificados' AS integration_result;
