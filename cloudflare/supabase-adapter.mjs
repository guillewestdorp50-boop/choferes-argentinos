// Draft compatibility adapter: Cloudflare Worker D1-style API backed by Supabase RPC.
// It is intentionally not wired into the production Worker until the SQL functions,
// secrets, preview tests, and data migration have all been verified.

const TABLES = [
  "communities", "profiles", "devices", "invites", "friend_links", "media",
  "posts", "comments", "reactions", "route_status", "route_alerts", "messages",
  "push_subscriptions", "badge_awards", "driver_activity"
];

function asHexBytea(value) {
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return "\\x" + Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }
  return value;
}

export function translateD1Sql(input) {
  let sql = String(input).trim();
  const ignoreInsert = /^INSERT\s+OR\s+IGNORE\s+INTO\s+/i.test(sql);
  if (ignoreInsert) sql = sql.replace(/^INSERT\s+OR\s+IGNORE\s+INTO\s+/i, "INSERT INTO ");

  for (const table of TABLES) {
    sql = sql.replace(new RegExp("\\b" + table + "\\b", "gi"), "ca_" + table);
  }

  sql = sql.replace(
    /datetime\(d\.last_seen_at\)\s*>=\s*datetime\('now'\s*,\s*'-3 minutes'\)/gi,
    "d.last_seen_at::timestamptz >= now() - interval '3 minutes'"
  );
  sql = sql.replace(
    /datetime\(COALESCE\(p\.moderated_at\s*,\s*p\.created_at\)\)\s*<=\s*datetime\('now'\s*,\s*'-5 minutes'\)/gi,
    "COALESCE(p.moderated_at,p.created_at)::timestamptz <= now() - interval '5 minutes'"
  );
  sql = sql.replace(/json_group_array\s*\(/gi, "jsonb_agg(");
  sql = sql.replace(/json_object\s*\(/gi, "jsonb_build_object(");

  // Postgres bytea accepts its hex input representation. The RPC receives it as text.
  if (/^INSERT INTO ca_media\b/i.test(sql)) {
    sql = sql.replace(/VALUES\s*\(([^)]*)\)/i, (_, values) => {
      const parts = values.split(",");
      if (parts.length === 6) parts[4] = parts[4].trim() + "::bytea";
      return "VALUES(" + parts.join(",") + ")";
    });
  }
  if (/^INSERT INTO ca_driver_activity\b/i.test(sql)) {
    sql = sql.replace(/VALUES\s*\(([^)]*)\)/i, (_, values) => {
      const parts = values.split(",");
      if (parts.length === 11) parts[8] = parts[8].trim() + "::bytea";
      return "VALUES(" + parts.join(",") + ")";
    });
  }

  if (ignoreInsert) sql += " ON CONFLICT DO NOTHING";
  return sql;
}

function encodeParams(params) {
  return params.map(asHexBytea);
}

function decodeBytea(value) {
  if (typeof value !== "string" || !/^\\x(?:[0-9a-f]{2})*$/i.test(value)) return value;
  const hex = value.slice(2);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function decodeRows(value) {
  if (Array.isArray(value)) return value.map(decodeRows);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = key === "data" || key === "audio_data" ? decodeBytea(item) : decodeRows(item);
  }
  return result;
}

export function createSupabaseDb(env, fetchImpl = fetch) {
  const baseUrl = String(env.SUPABASE_URL || "").replace(/\/$/, "");
  // Prefer the modern Supabase secret key. Keep the legacy service_role name
  // as a backwards-compatible fallback while existing deployments migrate.
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !secret) throw new Error("Faltan SUPABASE_URL o SUPABASE_SECRET_KEY.");

  async function rpc(name, payload) {
    const response = await fetchImpl(baseUrl + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: secret,
        // New sb_secret keys are opaque and must be sent only as apikey.
        // Legacy service_role keys are JWTs and continue to use Bearer auth.
        ...(secret.startsWith("sb_secret_") ? {} : { authorization: "Bearer " + secret })
      },
      body: JSON.stringify(payload)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error("Supabase RPC " + name + " (" + response.status + "): " + raw.slice(0, 500));
    return raw ? decodeRows(JSON.parse(raw)) : null;
  }

  function statement(sql, params = []) {
    const translated = translateD1Sql(sql);
    const bound = [...params];
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async first() {
        const result = await rpc("ca_worker_query", { p_sql: translated, p_params: encodeParams(bound) });
        return result?.results?.[0] ?? null;
      },
      async all() {
        const result = await rpc("ca_worker_query", { p_sql: translated, p_params: encodeParams(bound) });
        return { success: true, results: result?.results ?? [] };
      },
      async run() {
        const result = await rpc("ca_worker_query", { p_sql: translated, p_params: encodeParams(bound) });
        return { success: Boolean(result?.success), meta: { changes: Number(result?.changes || 0) } };
      },
      _operation() {
        return { sql: translated, params: encodeParams(bound) };
      }
    };
  }

  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      const operations = statements.map(item => item._operation());
      return rpc("ca_worker_batch", { p_operations: operations });
    }
  };
}
