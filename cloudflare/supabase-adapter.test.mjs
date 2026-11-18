import test from "node:test";
import assert from "node:assert/strict";
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
