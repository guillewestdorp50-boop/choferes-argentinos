import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translateD1Sql, createSupabaseDb } from "./supabase-adapter.mjs";

test("prefixes every D1 table with ca_", () => {
  assert.equal(
    translateD1Sql("SELECT p.id FROM profiles p JOIN devices d ON d.profile_id=p.id"),
    "SELECT p.id FROM ca_profiles p JOIN ca_devices d ON d.profile_id=p.id"
  );
});

test("translates SQLite ignore inserts and timestamp functions", () => {
  assert.equal(
    translateD1Sql("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)"),
    "INSERT INTO ca_friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING"
  );
  assert.match(
    translateD1Sql("SELECT id FROM profiles WHERE datetime(COALESCE(p.moderated_at,p.created_at)) <= datetime('now','-5 minutes')"),
    /COALESCE\(p\.moderated_at,p\.created_at\)::timestamptz <= now\(\) - interval '5 minutes'/
  );
  assert.match(
    translateD1Sql("SELECT id FROM devices WHERE datetime(d.last_seen_at)>=datetime('now','-3 minutes')"),
    /d\.last_seen_at::timestamptz >= now\(\) - interval '3 minutes'/
  );
});

test("translates badge JSON aggregation", () => {
  assert.match(
    translateD1Sql("SELECT json_group_array(json_object('badge_key',ba.badge_key,'level',ba.level)) FROM badge_awards ba"),
    /jsonb_agg\(jsonb_build_object/
  );
});

test("casts binary inserts to bytea", () => {
  assert.match(
    translateD1Sql("INSERT INTO media(id,community_id,profile_id,mime_type,data,created_at) VALUES(?,?,?,?,?,?)"),
    /\?::bytea/
  );
  assert.match(
    translateD1Sql("INSERT INTO driver_activity(id,community_id,profile_id,kind,location_label,body,media_id,audio_mime_type,audio_data,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)"),
    /\?::bytea,'pending'/
  );
});

test("uses server-only Supabase RPC and decodes returned bytea", async () => {
  let captured;
  const db = createSupabaseDb({
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_SERVICE_ROLE_KEY: "server-secret"
  }, async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, results: [{ data: "\\x4142" }] }), { status: 200 });
  });
  const row = await db.prepare("SELECT data FROM media WHERE id=?").bind("media-id").first();
  assert.equal(captured.url, "https://example.supabase.co/rest/v1/rpc/ca_worker_query");
  assert.equal(captured.init.headers.apikey, "server-secret");
  assert.deepEqual(Array.from(row.data), [0x41, 0x42]);
});

test("preserves D1 run/all/batch result shapes", async () => {
  const calls = [];
  const db = createSupabaseDb({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "server-secret"
  }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const payload = url.endsWith("ca_worker_batch")
      ? [{ success: true, changes: 1 }]
      : url.endsWith("ca_worker_query") && calls.length === 1
        ? { success: true, changes: 1 }
        : { success: true, results: [{ id: "one" }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  const run = await db.prepare("UPDATE profiles SET bio=? WHERE id=?").bind("bio", "p1").run();
  assert.equal(run.success, true);
  assert.equal(run.meta.changes, 1);
  const all = await db.prepare("SELECT id FROM profiles WHERE id=?").bind("p1").all();
  assert.equal(all.results[0].id, "one");
  const batch = await db.batch([
    db.prepare("INSERT INTO profiles(id,community_id,nickname,created_at,updated_at) VALUES(?,?,?,?,?)")
      .bind("p2", "c1", "driver", "t1", "t1")
  ]);
  assert.equal(calls[2].url.endsWith("ca_worker_batch"), true);
  assert.equal(Array.isArray(batch), true);
});

test("schema RPC is service-role-only and restricts referenced tables", async () => {
  const schema = await readFile(new URL("../supabase/ca_schema_draft.sql", import.meta.url), "utf8");
  assert.match(schema, /REVOKE ALL ON FUNCTION public\.ca_worker_query\(text, jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(schema, /GRANT EXECUTE ON FUNCTION public\.ca_worker_query\(text, jsonb\) TO service_role/);
  assert.match(schema, /La consulta intentó acceder a una tabla ajena a Choferes Argentinos/);
});


test("translates all 65 Worker SQL statements without SQLite-only syntax", async () => {
  const worker = await readFile(new URL("./worker.js", import.meta.url), "utf8");
  const statements = [];
  const pattern = /env\.DB\.prepare\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\`([\s\S]*?)\`)\s*\)/g;
  let match;
  while ((match = pattern.exec(worker)) !== null) {
    const sql = (match[1] ?? match[2] ?? match[3]).replace(/\\n/g, "\n");
    statements.push(translateD1Sql(sql));
  }
  assert.equal(statements.length, 65, "cambió el número de consultas: revisar el inventario");
  for (const sql of statements) {
    assert.doesNotMatch(sql, /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:communities|profiles|devices|invites|friend_links|media|posts|comments|reactions|route_status|route_alerts|messages|push_subscriptions|badge_awards|driver_activity)\b/i);
    assert.doesNotMatch(sql, /INSERT\s+OR\s+IGNORE|datetime\s*\(|json_group_array|json_object\s*\(/i);
  }
});


test("sends modern Supabase secret keys only through the apikey header", async () => {
  let captured;
  const db = createSupabaseDb({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_test-secret"
  }, async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ success: true, results: [{ total: 0 }] }), { status: 200 });
  });
  const row = await db.prepare("SELECT COUNT(*) AS total FROM communities").first();
  assert.equal(row.total, 0);
  assert.equal(captured.init.headers.apikey, "sb_secret_test-secret");
  assert.equal("authorization" in captured.init.headers, false);
});

test("prefers SUPABASE_SECRET_KEY over the legacy service role variable", async () => {
  let captured;
  const db = createSupabaseDb({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_preferred",
    SUPABASE_SERVICE_ROLE_KEY: "legacy-jwt"
  }, async (_url, init) => {
    captured = init;
    return new Response(JSON.stringify({ success: true, results: [] }), { status: 200 });
  });
  await db.prepare("SELECT id FROM profiles").first();
  assert.equal(captured.headers.apikey, "sb_secret_preferred");
  assert.equal("authorization" in captured.headers, false);
});
