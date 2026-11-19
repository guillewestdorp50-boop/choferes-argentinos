const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();
const BADGE_CATALOG = [{"key":"rueda_nueva","name":"Rueda Nueva","description":"Primeros pasos y adaptación a la vida camionera."},{"key":"volante_firme","name":"Volante Firme","description":"Experiencia, responsabilidad y criterio al volante."},{"key":"kilometro_de_oro","name":"Kilómetro de Oro","description":"Trayectoria y constancia demostradas en la ruta."},{"key":"senor_de_las_rutas","name":"Señor de las Rutas","description":"Referente respetado por su experiencia y conducta."},{"key":"mano_camionera","name":"Mano Camionera","description":"Ayuda concreta y compañerismo con otros camioneros."},{"key":"ojo_rutero","name":"Ojo Rutero","description":"Avisos de ruta útiles, oportunos y comprobados."},{"key":"rey_de_la_noche","name":"Rey de la Noche","description":"Experiencia y responsabilidad en recorridos nocturnos."},{"key":"mecanico_de_emergencia","name":"Mecánico de Emergencia","description":"Conocimientos y asistencia mecánica que ayudan en ruta."},{"key":"companero_solidario","name":"Compañero Solidario","description":"Apoyo real a colegas ante una necesidad."},{"key":"veterano_del_volante","name":"Veterano del Volante","description":"Años de oficio y experiencia camionera reconocida."},{"key":"carga_segura","name":"Carga Segura","description":"Compromiso demostrado con el cuidado de la carga y la seguridad."},{"key":"vieja_escuela","name":"De la vieja escuela","description":"Respeto, experiencia, códigos y compañerismo de la vieja escuela camionera."}];
const BADGE_LEVELS = ["Bronce","Plata","Oro","Platino","Diamante"];
const badgeRank = level => BADGE_LEVELS.indexOf(level);


function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(message, status = 400, headers = {}) { return json({ error: message }, status, headers); }
function cleanText(value, max) { return String(value ?? "").trim().slice(0, max); }
function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
function nicknameKey(value) {
  return cleanText(value, 32).normalize("NFKC").toLocaleLowerCase("es-AR");
}
function loginUsername(value) {
  return cleanText(value, 32).normalize("NFKC").toLowerCase();
}
async function derivePassword(password, saltHex, iterations) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(part => parseInt(part, 16)));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function nicknameTaken(env, nickname, excludeProfileId = null) {
  const key = nicknameKey(nickname);
  const row = await env.DB.prepare(
    "SELECT id FROM profiles WHERE nickname_key=? AND id NOT LIKE 'el-viejo-%' AND (? IS NULL OR id<>?) LIMIT 1"
  ).bind(key, excludeProfileId, excludeProfileId).first();
  return !!row;
}
async function ensureCredentialsSchema(env) {
  // Detect columns by preparing a harmless SELECT. D1 does not expose
  // consistent PRAGMA metadata in every execution context.
  for (const [name, type] of [
    ["login_username", "TEXT"],
    ["password_salt", "TEXT"],
    ["password_hash", "TEXT"],
    ["password_iterations", "INTEGER"]
  ]) {
    let exists = false;
    try {
      await env.DB.prepare(`SELECT ${name} FROM profiles LIMIT 0`).all();
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      try {
        await env.DB.prepare(`ALTER TABLE profiles ADD COLUMN ${name} ${type}`).run();
      } catch (error) {
        // A concurrent request may have added the column after our probe.
        try {
          await env.DB.prepare(`SELECT ${name} FROM profiles LIMIT 0`).all();
        } catch {
          throw error;
        }
      }
    }
  }

  // The login and recovery flows both use this table. It may be absent when
  // the earlier multi-statement migration stopped partway through.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_key TEXT PRIMARY KEY,
    failed_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL,
    locked_until TEXT
  )`).run();

  // Idempotent and non-destructive; NULL usernames remain allowed.
  const duplicate = await env.DB.prepare(
    "SELECT login_username FROM profiles WHERE login_username IS NOT NULL GROUP BY login_username HAVING COUNT(*) > 1 LIMIT 1"
  ).first();
  if (duplicate) throw new Error("Hay nombres de usuario duplicados; no se modificó ninguna cuenta.");
  await env.DB.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS profiles_login_username_unique_idx ON profiles(login_username) WHERE login_username IS NOT NULL"
  ).run();
}
async function bodyJson(request) {
  try { return await request.json(); } catch { return null; }
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.APP_ORIGIN || "";
  if (origin && origin !== allowed) return null;
  return {
    "access-control-allow-origin": origin || allowed,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type,X-Setup-Secret",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}
async function auth(request, env) {
  const raw = request.headers.get("Authorization") || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
  if (!token || token.length !== 64) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT d.id AS device_id, d.last_seen_at, p.id AS profile_id, p.community_id, p.nickname, p.role, p.bio, p.avatar_key, p.avatar_media_id
     FROM devices d JOIN profiles p ON p.id=d.profile_id
     WHERE d.token_hash=? AND d.revoked_at IS NULL LIMIT 1`
  ).bind(tokenHash).first();
  if (row && Date.now() - Date.parse(row.last_seen_at) > 60000) {
    await env.DB.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").bind(now(), row.device_id).run();
  }
  return row || null;
}
async function issueDevice(env, profileId) {
  const token = makeToken();
  const timestamp = now();
  await env.DB.prepare(
    "INSERT INTO devices(id,profile_id,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)"
  ).bind(id(), profileId, await sha256(token), timestamp, timestamp).run();
  return token;
}
async function createInvite(env, communityId, kind, creatorId, targetProfileId = null) {
  const code = makeCode();
  const timestamp = now();
  const days = kind === "device" ? 1 : 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  const maxUses = 1;
  await env.DB.prepare(
    `INSERT INTO invites(id,community_id,code_hash,kind,created_by_profile_id,target_profile_id,max_uses,uses,expires_at,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).bind(id(), communityId, await sha256(code), kind, creatorId, targetProfileId, maxUses, 0, expires, timestamp).run();
  return { code, expires_at: expires, uses: maxUses };
}
async function consumeInvite(env, code, allowedKinds) {
  const codeHash = await sha256(code.toUpperCase());
  const invite = await env.DB.prepare("SELECT * FROM invites WHERE code_hash=? LIMIT 1").bind(codeHash).first();
  if (!invite || !allowedKinds.includes(invite.kind)) return null;
  const result = await env.DB.prepare(
    "UPDATE invites SET uses=uses+1 WHERE id=? AND uses<max_uses AND expires_at>?"
  ).bind(invite.id, now()).run();
  if (!result.success || result.meta.changes !== 1) return null;
  return invite;
}


function toB64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=/g, "");
}
function fromB64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function concatBytes(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
async function hkdfSha256(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}
async function sendWebPush(env, subscription, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { ok: false, configured: false, status: 0 };
  try {
    const publicKeyBytes = fromB64Url(env.VAPID_PUBLIC_KEY);
    const privateKeyBytes = fromB64Url(env.VAPID_PRIVATE_KEY);
    if (publicKeyBytes.length !== 65 || privateKeyBytes.length !== 32) return { ok: false, configured: false, status: 0 };
    const signingJwk = {
      kty: "EC", crv: "P-256",
      x: toB64Url(publicKeyBytes.slice(1, 33)),
      y: toB64Url(publicKeyBytes.slice(33, 65)),
      d: toB64Url(privateKeyBytes),
      ext: true, key_ops: ["sign"]
    };
    const signingKey = await crypto.subtle.importKey("jwk", signingJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const endpoint = new URL(subscription.endpoint);
    if (endpoint.protocol !== "https:") return { ok: false, configured: true, status: 400 };
    const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
    const header = toB64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = toB64Url(encoder.encode(JSON.stringify({ aud: endpoint.origin, exp: expires, sub: env.VAPID_SUBJECT || env.APP_ORIGIN })));
    const unsignedJwt = header + "." + claims;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(unsignedJwt)));
    const jwt = unsignedJwt + "." + toB64Url(signature);
    const userPublicKey = fromB64Url(subscription.p256dh);
    const authSecret = fromB64Url(subscription.auth);
    if (userPublicKey.length !== 65 || authSecret.length < 16) return { ok: false, configured: true, status: 400 };
    const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
    const userKey = await crypto.subtle.importKey("raw", userPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userKey }, serverKeys.privateKey, 256));
    const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), userPublicKey, serverPublicKey);
    const inputKeyMaterial = await hkdfSha256(sharedSecret, authSecret, keyInfo, 32);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const contentKey = await hkdfSha256(inputKeyMaterial, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdfSha256(inputKeyMaterial, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
    const plaintext = concatBytes(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
    const aesKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));
    const body = concatBytes(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([serverPublicKey.length]), serverPublicKey, ciphertext);
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        "Authorization": "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Urgency": "high"
      },
      body
    });
    return { ok: response.ok, configured: true, status: response.status };
  } catch {
    return { ok: false, configured: true, status: 0 };
  }
}
async function notifyModerators(env, communityId, postId, nickname) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const result = await env.DB.prepare(
    `SELECT s.id,s.endpoint,s.p256dh,s.auth
     FROM push_subscriptions s JOIN profiles p ON p.id=s.profile_id
     WHERE p.community_id=? AND p.role IN ('owner','moderator')`
  ).bind(communityId).all();
  const payload = {
    title: "Nueva publicación para revisar",
    body: (nickname || "Un compañero") + " publicó algo en Choferes Argentinos.",
    url: (env.APP_ORIGIN || "") + "/?tab=moderacion&post=" + encodeURIComponent(postId),
    tag: "ca-pending-" + postId,
    post_id: postId
  };
  const outcomes = await Promise.all((result.results || []).map(async subscription => {
    const sent = await sendWebPush(env, subscription, payload);
    if (sent.status === 404 || sent.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id=?").bind(subscription.id).run();
    }
    return sent.ok ? 1 : 0;
  }));
  return outcomes.reduce((sum, value) => sum + value, 0);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return fail("Origen no autorizado.", 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/api/health") {
        return json({ ok: true, service: "choferes-argentinos-api" }, 200, cors);
      }
      if (request.method === "GET" && path === "/api/push/public-key") {
        return json({ enabled: Boolean(env.VAPID_PUBLIC_KEY), public_key: env.VAPID_PUBLIC_KEY || null }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/recover-pin") {
        const input = await bodyJson(request);
        const nickname = cleanText(input?.nickname, 32);
        const pin = String(input?.pin || "");
        const key = nicknameKey(nickname);
        if (nickname.length < 2 || !/^\d{4}$/.test(pin)) return fail("Apodo o PIN incorrectos.", 401, cors);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const attemptKey = await sha256("pin|" + key + "|" + ip);
        const previous = await env.DB.prepare("SELECT failed_count,window_started_at,locked_until FROM login_attempts WHERE attempt_key=?")
          .bind(attemptKey).first();
        if (previous?.locked_until && Date.parse(previous.locked_until) > Date.now()) {
          return fail("Apodo o PIN incorrectos. Esperá unos minutos e intentá nuevamente.", 429, cors);
        }
        const profile = await env.DB.prepare(
          "SELECT id,recovery_pin_salt,recovery_pin_hash FROM profiles WHERE nickname_key=? AND id NOT LIKE 'el-viejo-%' LIMIT 1"
        ).bind(key).first();
        let valid = false;
        if (profile?.recovery_pin_salt && profile?.recovery_pin_hash) {
          const candidate = await derivePassword(pin, profile.recovery_pin_salt, 100000);
          valid = constantTimeEqual(candidate, profile.recovery_pin_hash);
        } else {
          await derivePassword(pin, "00000000000000000000000000000000", 100000);
        }
        if (!valid) {
          const withinWindow = previous?.window_started_at && Date.now() - Date.parse(previous.window_started_at) < 15 * 60 * 1000;
          const failedCount = withinWindow ? Number(previous.failed_count || 0) + 1 : 1;
          const windowStarted = withinWindow ? previous.window_started_at : now();
          const lockedUntil = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
          await env.DB.prepare(
            `INSERT INTO login_attempts(attempt_key,failed_count,window_started_at,locked_until)
             VALUES(?,?,?,?)
             ON CONFLICT(attempt_key) DO UPDATE SET failed_count=excluded.failed_count,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until`
          ).bind(attemptKey, failedCount, windowStarted, lockedUntil).run();
          return fail("Apodo o PIN incorrectos.", 401, cors);
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind(attemptKey).run();
        const token = await issueDevice(env, profile.id);
        return json({ token, recovered: true }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/login") {
        const input = await bodyJson(request);
        const username = loginUsername(input?.username);
        const password = String(input?.password || "");
        if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username) || password.length < 1 || password.length > 128) {
          return fail("Usuario o contraseña incorrectos.", 401, cors);
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const attemptKey = await sha256(username + "|" + ip);
        const previous = await env.DB.prepare("SELECT failed_count,window_started_at,locked_until FROM login_attempts WHERE attempt_key=?")
          .bind(attemptKey).first();
        if (previous?.locked_until && Date.parse(previous.locked_until) > Date.now()) {
          return fail("Usuario o contraseña incorrectos. Esperá unos minutos e intentá nuevamente.", 429, cors);
        }
        const profile = await env.DB.prepare(
          "SELECT id,password_salt,password_hash,password_iterations FROM profiles WHERE login_username=? LIMIT 1"
        ).bind(username).first();
        let valid = false;
        if (profile?.password_hash && profile?.password_salt && profile?.password_iterations) {
          const candidate = await derivePassword(password, profile.password_salt, profile.password_iterations);
          valid = constantTimeEqual(candidate, profile.password_hash);
        } else {
          await derivePassword(password, "00000000000000000000000000000000", 100000);
        }
        if (!valid) {
          const withinWindow = previous?.window_started_at && Date.now() - Date.parse(previous.window_started_at) < 15 * 60 * 1000;
          const failedCount = withinWindow ? Number(previous.failed_count || 0) + 1 : 1;
          const windowStarted = withinWindow ? previous.window_started_at : now();
          const lockedUntil = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
          await env.DB.prepare(
            `INSERT INTO login_attempts(attempt_key,failed_count,window_started_at,locked_until)
             VALUES(?,?,?,?)
             ON CONFLICT(attempt_key) DO UPDATE SET failed_count=excluded.failed_count,window_started_at=excluded.window_started_at,locked_until=excluded.locked_until`
          ).bind(attemptKey, failedCount, windowStarted, lockedUntil).run();
          return fail("Usuario o contraseña incorrectos.", 401, cors);
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind(attemptKey).run();
        const token = await issueDevice(env, profile.id);
        return json({ token, logged_in: true }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/bootstrap") {
        const secret = request.headers.get("X-Setup-Secret") || "";
        if (!env.SETUP_SECRET || secret !== env.SETUP_SECRET) return fail("Configuración no autorizada.", 401, cors);
        const input = await bodyJson(request);
        const communityName = cleanText(input?.community_name || "Choferes Argentinos", 80);
        const nickname = cleanText(input?.nickname, 32);
        if (nickname.length < 2) return fail("El apodo debe tener al menos 2 caracteres.", 400, cors);
        if (await nicknameTaken(env, nickname)) return fail("Ese apodo ya está en uso. Elegí otro.", 409, cors);
        const existing = await env.DB.prepare("SELECT id FROM communities LIMIT 1").first();
        if (existing) return fail("La comunidad ya fue inicializada.", 409, cors);
        const communityId = id(), profileId = id(), timestamp = now();
        const inviteCode = makeCode(), recoveryCode = makeCode(), token = makeToken();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO communities(id,name,created_at) VALUES(?,?,?)").bind(communityId, communityName, timestamp),
          env.DB.prepare("INSERT INTO profiles(id,community_id,nickname,nickname_key,role,created_at,updated_at,recovery_code) VALUES(?,?,?,?,'owner',?,?,?)").bind(profileId, communityId, nickname, nicknameKey(nickname), timestamp, timestamp, recoveryCode),
          env.DB.prepare("INSERT INTO devices(id,profile_id,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)").bind(id(), profileId, await sha256(token), timestamp, timestamp),
          env.DB.prepare("INSERT INTO invites(id,community_id,code_hash,kind,created_by_profile_id,max_uses,uses,expires_at,created_at) VALUES(?,?,?,'community',?,1,0,?,?)").bind(id(), communityId, await sha256(inviteCode), profileId, new Date(Date.now() + 30 * 86400000).toISOString(), timestamp)
        ]);
        return json({
          token, invite_code: inviteCode,
          profile: { id: profileId, nickname, role: "owner" },
          community: { id: communityId, name: communityName },
          note: "Guardá el código de invitación. Quitá SETUP_SECRET después de inicializar."
        }, 201, cors);
      }

      if (request.method === "POST" && path === "/api/join") {
        const input = await bodyJson(request);
        const code = cleanText(input?.code, 32).toUpperCase();
        const nickname = cleanText(input?.nickname, 32);
        if (!code || nickname.length < 2) return fail("Código y apodo son obligatorios.", 400, cors);
        if (await nicknameTaken(env, nickname)) return fail("Ese apodo ya está en uso. Elegí otro.", 409, cors);
        const invite = await consumeInvite(env, code, ["community", "friend"]);
        if (!invite) return fail("Código inválido, vencido o ya utilizado.", 400, cors);
        const profileId = id(), timestamp = now(), token = makeToken();
        const stmts = [
          env.DB.prepare("INSERT INTO profiles(id,community_id,nickname,nickname_key,role,created_at,updated_at,recovery_code) VALUES(?,?,?,?,'member',?,?,?)").bind(profileId, invite.community_id, nickname, nicknameKey(nickname), timestamp, timestamp, code),
          env.DB.prepare("UPDATE invites SET used_by_profile_id=? WHERE id=? AND used_by_profile_id IS NULL").bind(profileId, invite.id),
          env.DB.prepare("INSERT INTO devices(id,profile_id,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)").bind(id(), profileId, await sha256(token), timestamp, timestamp)
        ];
        if (invite.kind === "friend" && invite.created_by_profile_id) {
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(profileId, invite.created_by_profile_id, timestamp));
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(invite.created_by_profile_id, profileId, timestamp));
        }
        await env.DB.batch(stmts);
        return json({ token, profile: { id: profileId, nickname, role: "member", community_id: invite.community_id } }, 201, cors);
      }

      if (request.method === "POST" && path === "/api/recover") {
        const input = await bodyJson(request);
        const nickname = cleanText(input?.nickname, 32);
        const code = cleanText(input?.code, 32).toUpperCase();
        if (!nickname || !code) return fail("Apodo y código de recuperación son obligatorios.", 400, cors);
        const profile = await env.DB.prepare(
          "SELECT id FROM profiles WHERE nickname_key=? AND recovery_code=? AND id NOT LIKE 'el-viejo-%' LIMIT 1"
        ).bind(nicknameKey(nickname), code).first();
        if (!profile) return fail("No encontramos una cuenta con esos datos. Revisá el apodo y el código e intentá nuevamente.", 400, cors);
        const token = await issueDevice(env, profile.id);
        return json({ token, recovered: true }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/link-device") {
        const input = await bodyJson(request);
        const code = cleanText(input?.code, 32).toUpperCase();
        if (!code) return fail("Falta el código de vinculación.", 400, cors);
        const invite = await consumeInvite(env, code, ["device"]);
        if (!invite?.target_profile_id) return fail("Código inválido, vencido o ya utilizado.", 400, cors);
        const token = await issueDevice(env, invite.target_profile_id);
        return json({ token, linked: true }, 201, cors);
      }

      const user = await auth(request, env);
      if (!user) return fail("Sesión no válida. Volvé a vincular tu dispositivo.", 401, cors);

      if (request.method === "GET" && path === "/api/account-data") {
        await ensureCredentialsSchema(env);
        const row = await env.DB.prepare("SELECT nickname,recovery_code,recovery_pin_hash,login_username,password_hash FROM profiles WHERE id=? AND community_id=?").bind(user.profile_id,user.community_id).first();
        return json({ nickname: row?.nickname || user.nickname, has_recovery_code: !!row?.recovery_code, has_pin: !!row?.recovery_pin_hash, login_username: row?.login_username || null, has_password: !!row?.password_hash }, 200, cors);
      }
      if (request.method === "POST" && path === "/api/account/credentials") {
        let credentialsStage = "schema";
        try {
        await ensureCredentialsSchema(env);
        credentialsStage = "read_request";
        const input = await bodyJson(request);
        const username = loginUsername(input?.username);
        const password = String(input?.password || "");
        if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username)) {
          return fail("El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo.", 400, cors);
        }
        if (password.length < 10 || password.length > 128) {
          return fail("La contraseña debe tener entre 10 y 128 caracteres.", 400, cors);
        }
        // La sesión autenticada (incluida una sesión recuperada mediante PIN) autoriza
        // el cambio de credenciales; no se exige una contraseña anterior olvidada.
        const taken = await env.DB.prepare("SELECT id FROM profiles WHERE login_username=? AND id<>? LIMIT 1")
          .bind(username, user.profile_id).first();
        if (taken) return fail("Ese usuario ya está ocupado. Elegí otro.", 409, cors);
        credentialsStage = "salt_generation";
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const salt = Array.from(saltBytes, b => b.toString(16).padStart(2, "0")).join("");
        const iterations = 100000;
        credentialsStage = "pbkdf2";
        const passwordHash = await derivePassword(password, salt, iterations);
        credentialsStage = "database_update";
        try {
          await env.DB.prepare(
            "UPDATE profiles SET login_username=?,password_salt=?,password_hash=?,password_iterations=?,updated_at=? WHERE id=? AND community_id=?"
          ).bind(username, salt, passwordHash, iterations, now(), user.profile_id, user.community_id).run();
        } catch {
          return fail("Ese usuario ya está ocupado. Elegí otro.", 409, cors);
        }
        return json({ ok: true, login_username: username, has_password: true }, 200, cors);
        } catch (error) {
          const technicalCause = String(error?.name || "Error") + ": " + String(error?.message || "sin detalle").slice(0, 180);
          console.error("account credentials failed", credentialsStage, technicalCause, error?.stack || "");
          return json({ error: "No se pudieron guardar las credenciales.", codigo_servidor: "CREDENTIALS_" + credentialsStage.toUpperCase(), causa_tecnica: technicalCause }, 500, cors);
        }
      }

      if (request.method === "POST" && path === "/api/recovery/setup") {
        const input = await bodyJson(request);
        const code = cleanText(input?.code, 32).toUpperCase();
        if (!code) return fail("Ingresá tu código original de invitación.", 400, cors);
        const hash = await sha256(code);
        const invite = await env.DB.prepare("SELECT id,used_by_profile_id FROM invites WHERE code_hash=? AND community_id=? AND kind IN ('community','friend') AND uses>0 LIMIT 1").bind(hash,user.community_id).first();
        if (!invite || (invite.used_by_profile_id && invite.used_by_profile_id !== user.profile_id)) return fail("Ese código no corresponde a tu cuenta o todavía no fue utilizado.", 400, cors);
        try {
          const result = await env.DB.prepare("UPDATE profiles SET recovery_code=? WHERE id=? AND (recovery_code IS NULL OR recovery_code=?)").bind(code,user.profile_id,code).run();
          if (result.success && result.meta.changes === 1 && !invite.used_by_profile_id) {
            await env.DB.prepare("UPDATE invites SET used_by_profile_id=? WHERE id=? AND used_by_profile_id IS NULL").bind(user.profile_id,invite.id).run();
          }
          if (!result.success || result.meta.changes !== 1) return fail("Ese código ya está asociado a otra cuenta o no pudo guardarse.", 409, cors);
        } catch (error) {
          return fail("No está aplicada todavía la actualización de recuperación en el servidor.", 503, cors);
        }
        return json({ ok:true, has_recovery_code:true }, 200, cors);
      }
      if (request.method === "POST" && path === "/api/recovery/owner-code") {
        if (user.role !== "owner") return fail("Solo el administrador principal puede generar este código.", 403, cors);
        const code = makeCode();
        const result = await env.DB.prepare("UPDATE profiles SET recovery_code=? WHERE id=? AND recovery_code IS NULL").bind(code,user.profile_id).run();
        if (!result.success || result.meta.changes !== 1) return fail("Ya existe un código personal o no se pudo generar.", 409, cors);
        return json({ok:true,has_recovery_code:true},200,cors);
      }
      if (request.method === "POST" && path === "/api/recovery/pin") {
        const input = await bodyJson(request);
        const pin = String(input?.pin || "");
        if (!/^\d{4}$/.test(pin)) return fail("El PIN debe tener exactamente cuatro números.", 400, cors);
        try {
          const saltBytes = crypto.getRandomValues(new Uint8Array(16));
          const salt = Array.from(saltBytes, b => b.toString(16).padStart(2,"0")).join("");
          const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
          const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt:saltBytes,iterations:100000,hash:"SHA-256"},material,256);
          const pinHash = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2,"0")).join("");
          const result = await env.DB.prepare("UPDATE profiles SET recovery_pin_salt=?,recovery_pin_hash=? WHERE id=? AND recovery_pin_hash IS NULL").bind(salt,pinHash,user.profile_id).run();
          if (!result.success) {
            console.error("recovery pin database update failed", result);
            return fail("No se pudo guardar el PIN en la base de datos. Tus datos siguen intactos.", 503, cors);
          }
          if (result.meta?.changes !== 1) return fail("El PIN ya está configurado o el perfil no pudo actualizarse.", 409, cors);
          return json({ok:true,has_pin:true},200,cors);
        } catch (error) {
          console.error("recovery pin setup failed", error);
          return fail("No se pudo configurar el PIN. No se modificó tu cuenta; intentá nuevamente.", 500, cors);
        }
      }
      if (request.method === "POST" && path === "/api/recovery/reveal") {
        const input = await bodyJson(request);
        const pin = String(input?.pin || "");
        if (!/^\d{4}$/.test(pin)) return fail("Ingresá tu PIN de cuatro números.", 400, cors);
        const row = await env.DB.prepare("SELECT nickname,recovery_code,recovery_pin_salt,recovery_pin_hash FROM profiles WHERE id=? AND community_id=?").bind(user.profile_id,user.community_id).first();
        if (!row?.recovery_pin_hash || !row?.recovery_pin_salt) return fail("Primero tenés que crear tu PIN en DATOS.", 400, cors);
        const saltBytes = Uint8Array.from(row.recovery_pin_salt.match(/.{2}/g).map(x=>parseInt(x,16)));
        const material = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({name:"PBKDF2",salt:saltBytes,iterations:100000,hash:"SHA-256"},material,256);
        const pinHash = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2,"0")).join("");
        if (pinHash !== row.recovery_pin_hash) return fail("PIN incorrecto. Podés volver a intentarlo; tu cuenta no se bloquea.", 400, cors);
        return json({nickname:row.nickname,recovery_code:row.recovery_code || null},200,cors);
      }
      if (request.method === "GET" && path === "/api/me") return json({ profile: user }, 200, cors);
      if (request.method === "POST" && path === "/api/logout") {
        await env.DB.prepare("UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(now(), user.device_id).run();
        return json({ ok: true, logged_out: true }, 200, cors);
      }
      if (request.method === "GET" && path === "/api/badges/catalog") {
        return json({ badges: BADGE_CATALOG, levels: BADGE_LEVELS }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/badges") {
        const targetId = cleanText(url.searchParams.get("profile_id") || user.profile_id, 64);
        const target = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.bio,p.role,p.avatar_key,p.avatar_media_id,
             (SELECT COUNT(*) FROM friend_links f WHERE f.profile_id=p.id) AS friend_count,
             EXISTS(SELECT 1 FROM devices d WHERE d.profile_id=p.id AND d.revoked_at IS NULL AND datetime(d.last_seen_at)>=datetime('now','-3 minutes')) AS is_online
           FROM profiles p WHERE p.id=? AND p.community_id=?`
        ).bind(targetId,user.community_id).first();
        if (!target) return fail("Perfil no encontrado en esta comunidad.",404,cors);
        const result = await env.DB.prepare(
          `SELECT badge_key,level,awarded_at FROM badge_awards WHERE community_id=? AND profile_id=? ORDER BY awarded_at DESC`
        ).bind(user.community_id,targetId).all();
        return json({ profile: target, awards: result.results || [] },200,cors);
      }

      if (request.method === "GET" && path === "/api/community/members") {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para ver esta lista.",403,cors);
        const result = await env.DB.prepare(
          "SELECT id,nickname FROM profiles WHERE community_id=? ORDER BY nickname LIMIT 500"
        ).bind(user.community_id).all();
        return json({ members: result.results || [] },200,cors);
      }

      if (request.method === "POST" && path === "/api/badges/award") {
        if (!["owner","moderator"].includes(user.role)) return fail("Solo administración puede entregar insignias.",403,cors);
        const input = await bodyJson(request);
        const targetId = cleanText(input?.profile_id,64);
        const badge = BADGE_CATALOG.find(item=>item.key===input?.badge_key);
        const level = cleanText(input?.level,16);
        if (!targetId || !badge || !BADGE_LEVELS.includes(level)) return fail("Elegí un compañero, una insignia y un nivel válidos.",400,cors);
        const target = await env.DB.prepare("SELECT id,nickname FROM profiles WHERE id=? AND community_id=?").bind(targetId,user.community_id).first();
        if (!target) return fail("Ese compañero no pertenece a esta comunidad.",404,cors);
        const timestamp=now();
        await env.DB.prepare(
          `INSERT INTO badge_awards(id,community_id,profile_id,badge_key,level,awarded_by_profile_id,awarded_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(profile_id,badge_key) DO UPDATE SET level=excluded.level,awarded_by_profile_id=excluded.awarded_by_profile_id,awarded_at=excluded.awarded_at`
        ).bind(id(),user.community_id,targetId,badge.key,level,user.profile_id,timestamp).run();
        const announcement = target.nickname+" recibió la insignia "+badge.name+" — "+level+". "+badge.description;
        await env.DB.prepare(
          "INSERT INTO posts(id,community_id,profile_id,body,created_at,status,moderated_by_profile_id,moderated_at) VALUES(?,?,?,?,?,'approved',?,?)"
        ).bind(id(),user.community_id,user.profile_id,announcement,timestamp,user.profile_id,timestamp).run();
        return json({ok:true,announcement,level,badge},201,cors);
      }


      if (request.method === "POST" && path === "/api/badges/remove") {
        if (!["owner","moderator"].includes(user.role)) return fail("Solo administración puede retirar insignias.",403,cors);
        const input = await bodyJson(request);
        const targetId = cleanText(input?.profile_id,64);
        const badge = BADGE_CATALOG.find(item=>item.key===input?.badge_key);
        if (!targetId || !badge) return fail("Elegí un compañero y una insignia válidos.",400,cors);
        const target = await env.DB.prepare("SELECT id FROM profiles WHERE id=? AND community_id=?").bind(targetId,user.community_id).first();
        if (!target) return fail("Ese compañero no pertenece a esta comunidad.",404,cors);
        const result = await env.DB.prepare("DELETE FROM badge_awards WHERE community_id=? AND profile_id=? AND badge_key=?").bind(user.community_id,targetId,badge.key).run();
        if (!result.success) return fail("No se pudo retirar la insignia. Intentá nuevamente.",500,cors);
        return json({ok:true,removed:result.meta?.changes===1},200,cors);
      }

      if (request.method === "POST" && path === "/api/push/subscribe") {
        if (!["owner", "moderator"].includes(user.role)) return fail("Solo un administrador puede activar estas alertas.", 403, cors);
        const input = await bodyJson(request);
        const endpoint = cleanText(input?.endpoint, 2048);
        const p256dh = cleanText(input?.keys?.p256dh, 256);
        const authSecret = cleanText(input?.keys?.auth, 256);
        let parsedEndpoint;
        try { parsedEndpoint = new URL(endpoint); } catch { return fail("La suscripción de notificaciones no es válida.", 400, cors); }
        if (parsedEndpoint.protocol !== "https:" || !p256dh || !authSecret) return fail("La suscripción de notificaciones está incompleta.", 400, cors);
        await env.DB.prepare(
          `INSERT INTO push_subscriptions(id,profile_id,endpoint,p256dh,auth,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(endpoint) DO UPDATE SET profile_id=excluded.profile_id,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`
        ).bind(id(), user.profile_id, endpoint, p256dh, authSecret, now(), now()).run();
        return json({ ok: true }, 201, cors);
      }

      if (request.method === "DELETE" && path === "/api/push/subscribe") {
        const input = await bodyJson(request);
        const endpoint = cleanText(input?.endpoint, 2048);
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE profile_id=? AND endpoint=?").bind(user.profile_id, endpoint).run();
        return json({ ok: true }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/moderation/posts") {
        if (!["owner", "moderator"].includes(user.role)) return fail("No tenés permiso para moderar publicaciones.", 403, cors);
        const result = await env.DB.prepare(
          `SELECT p.id,p.profile_id,p.body,p.media_id,p.created_at,pr.nickname
           FROM posts p JOIN profiles pr ON pr.id=p.profile_id
           WHERE p.community_id=? AND p.status='pending' AND p.deleted_at IS NULL
           ORDER BY p.created_at ASC LIMIT 100`
        ).bind(user.community_id).all();
        return json({ posts: result.results || [] }, 200, cors);
      }

      const moderationMatch = path.match(/^\/api\/moderation\/posts\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && moderationMatch) {
        if (!["owner", "moderator"].includes(user.role)) return fail("No tenés permiso para moderar publicaciones.", 403, cors);
        const input = await bodyJson(request);
        const action = input?.action;
        if (!["approve", "reject"].includes(action)) return fail("Acción de moderación inválida.", 400, cors);
        const status = action === "approve" ? "approved" : "rejected";
        const result = await env.DB.prepare(
          "UPDATE posts SET status=?,moderated_by_profile_id=?,moderated_at=? WHERE id=? AND community_id=? AND status='pending' AND deleted_at IS NULL"
        ).bind(status, user.profile_id, now(), moderationMatch[1], user.community_id).run();
        if (!result.success || result.meta.changes !== 1) return fail("La publicación ya no está pendiente o no existe.", 404, cors);
        return json({ ok: true, status }, 200, cors);
      }

      if (request.method === "PATCH" && path === "/api/profile") {
        const input = await bodyJson(request);
        const nickname = cleanText(input?.nickname, 32);
        const bio = cleanText(input?.bio, 160);
        const avatarKey = cleanText(input?.avatar_key || user.avatar_key || "truck", 24);
        const allowedAvatars = ["truck","truck2","tractor","wheel","road","gear","flag","fuel","wrench","construction","pickup","bus","admin_crown","admin_shield","admin_star","admin_wheel","admin_eagle"];
        const avatarMediaId = Object.prototype.hasOwnProperty.call(input || {}, "avatar_media_id")
          ? (input.avatar_media_id ? cleanText(input.avatar_media_id, 64) : null)
          : (user.avatar_media_id || null);
        if (nickname.length < 2) return fail("El apodo debe tener al menos 2 caracteres.", 400, cors);
        if (await nicknameTaken(env, nickname, user.profile_id)) return fail("Ese apodo ya está en uso. Elegí otro.", 409, cors);
        if (!allowedAvatars.includes(avatarKey)) return fail("Avatar no válido.", 400, cors);
        if (avatarKey.startsWith("admin_") && user.role !== "owner") return fail("Estos avatares son exclusivos de la cuenta administradora.", 403, cors);
        if (avatarMediaId) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id=? AND community_id=? AND profile_id=?")
            .bind(avatarMediaId, user.community_id, user.profile_id).first();
          if (!media) return fail("La foto no pertenece a tu perfil o no está disponible.", 400, cors);
        }
        try {
          await env.DB.prepare("UPDATE profiles SET nickname=?,nickname_key=?,bio=?,avatar_key=?,avatar_media_id=?,updated_at=? WHERE id=? AND community_id=?")
            .bind(nickname, nicknameKey(nickname), bio, avatarKey, avatarMediaId, now(), user.profile_id, user.community_id).run();
        } catch {
          return fail("Ese apodo ya está en uso. Elegí otro.", 409, cors);
        }
        return json({ ok: true, nickname, bio, avatar_key: avatarKey, avatar_media_id: avatarMediaId }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/invites") {
        const input = await bodyJson(request);
        const kind = input?.kind;
        if (!["friend", "device", "community"].includes(kind)) return fail("Tipo de invitación inválido.", 400, cors);
        if (user.role !== "owner") return fail("Solo el administrador principal puede emitir códigos de invitación.", 403, cors);
        const invite = await createInvite(env, user.community_id, kind, user.profile_id, kind === "device" ? user.profile_id : null);
        return json(invite, 201, cors);
      }

            if (request.method === "POST" && path === "/api/friends/el-viejo") {
        const timestamp = now();
        const viejoId = "el-viejo-" + user.community_id;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO profiles(id,community_id,nickname,nickname_key,bio,role,created_at,updated_at,avatar_key)
           VALUES(?,?,?,?,?,'member',?,?,?)`
        ).bind(viejoId,user.community_id,"El Viejo",nicknameKey("El Viejo"),"Siempre en la ruta · Chofer argentino",timestamp,timestamp,"el-viejo").run();
        await env.DB.prepare(
          `INSERT OR IGNORE INTO badge_awards(id,community_id,profile_id,badge_key,level,awarded_by_profile_id,awarded_at)
           VALUES(?,?,?,?,?,?,?)`
        ).bind(id(),user.community_id,viejoId,"vieja_escuela","Diamante",user.profile_id,timestamp).run();
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(user.profile_id,viejoId,timestamp),
          env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(viejoId,user.profile_id,timestamp)
        ]);
        return json({ok:true,profile_id:viejoId},200,cors);
      }

      if (request.method === "GET" && path === "/api/friends") {
        const result = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.bio,p.avatar_key,p.avatar_media_id,
             EXISTS(SELECT 1 FROM devices d WHERE d.profile_id=p.id AND d.revoked_at IS NULL AND datetime(d.last_seen_at)>=datetime('now','-3 minutes')) AS is_online
           FROM friend_links f JOIN profiles p ON p.id=f.friend_profile_id
           WHERE f.profile_id=? AND p.community_id=? ORDER BY p.nickname LIMIT 200`
        ).bind(user.profile_id, user.community_id).all();
        return json({ friends: result.results || [] }, 200, cors);
      }if (request.method === "GET" && path === "/api/community/colleagues") {
        const result = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.avatar_key,p.avatar_media_id,
             EXISTS(SELECT 1 FROM devices d WHERE d.profile_id=p.id AND d.revoked_at IS NULL AND datetime(d.last_seen_at)>=datetime('now','-3 minutes')) AS is_online,
             s.status AS route_status,s.updated_at AS route_updated_at
           FROM profiles p
           LEFT JOIN route_status s ON s.profile_id=p.id AND s.community_id=p.community_id AND s.expires_at>?
           WHERE p.community_id=? AND p.id NOT LIKE 'el-viejo-%' ORDER BY p.nickname COLLATE NOCASE LIMIT 500`
        ).bind(now(), user.community_id).all();
        return json({ colleagues: result.results || [] }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/friends") {
        const result = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.bio,p.avatar_key,p.avatar_media_id,
             EXISTS(SELECT 1 FROM devices d WHERE d.profile_id=p.id AND d.revoked_at IS NULL AND datetime(d.last_seen_at)>=datetime('now','-3 minutes')) AS is_online
           FROM friend_links f JOIN profiles p ON p.id=f.friend_profile_id
           WHERE f.profile_id=? AND p.community_id=? ORDER BY p.nickname LIMIT 200`
        ).bind(user.profile_id, user.community_id).all();
        return json({ friends: result.results || [] }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/posts") {
        const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit") || 40)));
        const targetProfileId = cleanText(url.searchParams.get("profile_id") || "", 64) || null;
        const result = await env.DB.prepare(
          `SELECT p.id,p.profile_id,p.body,p.media_id,p.source_activity_id,p.created_at,pr.nickname,pr.avatar_key,pr.avatar_media_id,
             COALESCE((SELECT json_group_array(json_object('badge_key',ba.badge_key,'level',ba.level)) FROM badge_awards ba WHERE ba.profile_id=p.profile_id), '[]') AS badges,
             (SELECT COUNT(*) * CASE WHEN datetime(COALESCE(p.moderated_at,p.created_at)) <= datetime('now','-5 minutes') THEN 5 ELSE 1 END
              FROM reactions r WHERE r.post_id=p.id AND r.reaction='like') AS likes,
             EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.profile_id=? AND r.reaction='like') AS liked_by_me
           FROM posts p JOIN profiles pr ON pr.id=p.profile_id
           WHERE p.community_id=? AND p.status='approved' AND p.deleted_at IS NULL AND (? IS NULL OR p.profile_id=?)
           ORDER BY p.created_at DESC LIMIT ?`
        ).bind(user.profile_id, user.community_id, targetProfileId, targetProfileId, limit).all();
        return json({ posts: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/posts") {
        const input = await bodyJson(request);
        const body = cleanText(input?.body, 2000);
        const mediaId = input?.media_id ? cleanText(input.media_id, 64) : null;
        if (!body && !mediaId) return fail("La publicación está vacía.", 400, cors);
        if (mediaId) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id=? AND community_id=? AND profile_id=?").bind(mediaId, user.community_id, user.profile_id).first();
          if (!media) return fail("La imagen no está disponible.", 400, cors);
        }
        const postId = id();
        const autoApprove = ["owner", "moderator"].includes(user.role);
        const status = autoApprove ? "approved" : "pending";
        await env.DB.prepare("INSERT INTO posts(id,community_id,profile_id,body,media_id,created_at,status) VALUES(?,?,?,?,?,?,?)")
          .bind(postId, user.community_id, user.profile_id, body, mediaId, now(), status).run();
        let notificationsSent = 0;
        if (!autoApprove) {
          try { notificationsSent = await notifyModerators(env, user.community_id, postId, user.nickname); } catch {}
        }
        return json({ id: postId, status, notifications_sent: notificationsSent }, 201, cors);
      }

      const postMatch = path.match(/^\/api\/posts\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && postMatch) {
        const input = await bodyJson(request);
        const body = cleanText(input?.body, 2000);
        const mediaId = input?.media_id ? cleanText(input.media_id, 64) : null;
        if (!body && !mediaId) return fail("La publicación no puede quedar vacía.",400,cors);
        if (mediaId) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id=? AND community_id=? AND profile_id=?").bind(mediaId,user.community_id,user.profile_id).first();
          if (!media) return fail("La imagen no está disponible.",400,cors);
        }
        const post = await env.DB.prepare("SELECT id,profile_id,status FROM posts WHERE id=? AND community_id=? AND deleted_at IS NULL").bind(postMatch[1],user.community_id).first();
        if (!post) return fail("Publicación no encontrada.",404,cors);
        if (post.profile_id !== user.profile_id) return fail("Solo podés editar tus propias publicaciones.",403,cors);
        const autoApprove = ["owner","moderator"].includes(user.role);
        const status = autoApprove ? "approved" : "pending";
        await env.DB.prepare("UPDATE posts SET body=?,media_id=?,status=?,moderated_by_profile_id=?,moderated_at=? WHERE id=? AND profile_id=? AND community_id=?")
          .bind(body,mediaId,status,autoApprove?user.profile_id:null,autoApprove?now():null,post.id,user.profile_id,user.community_id).run();
        if (!autoApprove) { try { await notifyModerators(env,user.community_id,post.id,user.nickname); } catch {} }
        return json({ok:true,status},200,cors);
      }

      if (request.method === "DELETE" && postMatch) {
        const post = await env.DB.prepare("SELECT id,profile_id FROM posts WHERE id=? AND community_id=? AND deleted_at IS NULL").bind(postMatch[1],user.community_id).first();
        if (!post) return fail("Publicación no encontrada.",404,cors);
        if (post.profile_id !== user.profile_id) return fail("Solo podés eliminar tus propias publicaciones.",403,cors);
        await env.DB.prepare("UPDATE posts SET deleted_at=? WHERE id=? AND profile_id=? AND community_id=?")
          .bind(now(),post.id,user.profile_id,user.community_id).run();
        return json({ok:true},200,cors);
      }

      // Driver PAD: all activity reports are held for moderator approval.
      if (request.method === "GET" && path === "/api/activity") {
        const result = await env.DB.prepare(
          `SELECT a.id,a.profile_id,a.kind,a.location_label,a.body,a.media_id,a.audio_mime_type,a.created_at,
                  pr.nickname,pr.avatar_key,pr.avatar_media_id,
                  (SELECT COUNT(*) FROM activity_reactions r WHERE r.activity_id=a.id) AS likes,
                  EXISTS(SELECT 1 FROM activity_reactions r WHERE r.activity_id=a.id AND r.profile_id=?) AS liked_by_me
           FROM driver_activity a JOIN profiles pr ON pr.id=a.profile_id
           WHERE a.community_id=? AND a.status='approved'
           ORDER BY a.created_at DESC LIMIT 100`
        ).bind(user.profile_id,user.community_id).all();
        return json({ activities: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/activity") {
        const form = await request.formData();
        const kind = cleanText(form.get("kind"), 24);
        const allowedKinds = ["libre","cargando","cargado","descargando","demorado","accidente","deposito","planta","base","casa","descansando","cafe","ypf","repostando","otro"];
        if (!allowedKinds.includes(kind)) return fail("Elegí una situación válida.", 400, cors);
        const body = cleanText(form.get("body"), 1200);
        const location = cleanText(form.get("location"), 160) || null;
        const mediaId = cleanText(form.get("media_id"), 64) || null;
        if (!body && !location && !mediaId && kind === "otro") return fail("Agregá una descripción para esta situación.", 400, cors);
        if (mediaId) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id=? AND community_id=? AND profile_id=?").bind(mediaId,user.community_id,user.profile_id).first();
          if (!media) return fail("La foto no está disponible.", 400, cors);
        }
        const audio = form.get("audio");
        let audioMime = null, audioBytes = null;
        if (audio && typeof audio.arrayBuffer === "function" && audio.size > 0) {
          const allowedAudio = ["audio/webm","audio/ogg","audio/mp4","audio/mpeg","audio/aac"];
          if (!allowedAudio.includes(audio.type)) return fail("Formato de audio no permitido.", 415, cors);
          if (audio.size > 3 * 1024 * 1024) return fail("El audio supera 3 MB.", 413, cors);
          audioMime = audio.type;
          audioBytes = new Uint8Array(await audio.arrayBuffer());
        }
        const activityId = id();
        await env.DB.prepare(
          "INSERT INTO driver_activity(id,community_id,profile_id,kind,location_label,body,media_id,audio_mime_type,audio_data,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)"
        ).bind(activityId,user.community_id,user.profile_id,kind,location,body,mediaId,audioMime,audioBytes,now()).run();
        return json({ id: activityId, status: "pending" }, 201, cors);
      }

      if (request.method === "GET" && path === "/api/moderation/activity") {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para moderar avisos del PAD.",403,cors);
        const result = await env.DB.prepare(
          `SELECT a.id,a.profile_id,a.kind,a.location_label,a.body,a.media_id,a.audio_mime_type,a.created_at,
                  pr.nickname
           FROM driver_activity a JOIN profiles pr ON pr.id=a.profile_id
           WHERE a.community_id=? AND a.status='pending'
           ORDER BY a.created_at ASC LIMIT 100`
        ).bind(user.community_id).all();
        return json({ activities: result.results || [] },200,cors);
      }

      const activityModerationMatch = path.match(/^\/api\/moderation\/activity\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && activityModerationMatch) {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para moderar avisos del PAD.",403,cors);
        const input = await bodyJson(request);
        if (!["approve","reject"].includes(input?.action)) return fail("Acción de moderación inválida.",400,cors);
        const status = input.action === "approve" ? "approved" : "rejected";
        const result = await env.DB.prepare(
          "UPDATE driver_activity SET status=?,moderated_by_profile_id=?,moderated_at=?,rejection_reason=? WHERE id=? AND community_id=? AND status='pending'"
        ).bind(status,user.profile_id,now(),status === "rejected" ? cleanText(input?.reason,240) || "El aviso necesita algunos cambios para cumplir las normas de convivencia." : null,activityModerationMatch[1],user.community_id).run();
        if (!result.success || result.meta.changes !== 1) return fail("El aviso ya no está pendiente o no existe.",404,cors);
        if(status==="approved"){
          const activity=await env.DB.prepare("SELECT id,profile_id,kind,location_label,body,media_id FROM driver_activity WHERE id=? AND community_id=?").bind(activityModerationMatch[1],user.community_id).first();
          if(activity){
            const label=({accidente:"🚨 ACCIDENTE",demorado:"⏳ DEMORA",otro:"⚠️ AVISO",libre:"🟢 LIBRE",cargando:"🟡 CARGANDO",cargado:"🔵 CARGADO",descargando:"🟠 DESCARGANDO"})[activity.kind]||activity.kind.toUpperCase();
            const wallBody=[label,activity.location_label||"",activity.body||""].filter(Boolean).join("\n\n");
            await env.DB.prepare("INSERT INTO posts(id,community_id,profile_id,body,media_id,created_at,status,moderated_by_profile_id,moderated_at,source_activity_id) VALUES(?,?,?,?,?,?,'approved',?,?,?)")
              .bind(id(),user.community_id,activity.profile_id,wallBody,activity.media_id,now(),user.profile_id,now(),activity.id).run();
          }
        }
        return json({ok:true,status},200,cors);
      }

      if (request.method === "POST" && path === "/api/activity/reactions") {
        const input=await bodyJson(request), activityId=cleanText(input?.activity_id,64);
        const activity=await env.DB.prepare("SELECT id FROM driver_activity WHERE id=? AND community_id=? AND status='approved'").bind(activityId,user.community_id).first();
        if(!activity)return fail("Aviso no encontrado.",404,cors);
        const existing=await env.DB.prepare("SELECT activity_id FROM activity_reactions WHERE activity_id=? AND profile_id=?").bind(activityId,user.profile_id).first();
        if(existing)await env.DB.prepare("DELETE FROM activity_reactions WHERE activity_id=? AND profile_id=?").bind(activityId,user.profile_id).run();
        else await env.DB.prepare("INSERT INTO activity_reactions(activity_id,profile_id,created_at) VALUES(?,?,?)").bind(activityId,user.profile_id,now()).run();
        return json({liked:!existing},200,cors);
      }

      const activityCommentDeleteMatch=path.match(/^\/api\/activity\/comments\/([0-9a-f-]{36})$/i);
      if(request.method==="DELETE" && activityCommentDeleteMatch){
        if(user.role!=="owner")return fail("Solo el administrador puede retirar comentarios.",403,cors);
        const comment=await env.DB.prepare("SELECT c.id,c.profile_id FROM activity_comments c JOIN driver_activity a ON a.id=c.activity_id WHERE c.id=? AND a.community_id=? AND a.status='approved'").bind(activityCommentDeleteMatch[1],user.community_id).first();
        if(!comment)return fail("Comentario no encontrado.",404,cors);
        const reason=cleanText((await bodyJson(request))?.reason,240)||"incumplía las normas de convivencia";
        const statements=[env.DB.prepare("DELETE FROM activity_comments WHERE id=?").bind(comment.id)];
        if(comment.profile_id!==user.profile_id)statements.push(env.DB.prepare("INSERT INTO comment_removal_notices(id,community_id,recipient_profile_id,reason,created_at) VALUES(?,?,?,?,?)").bind(id(),user.community_id,comment.profile_id,reason,now()));
        await env.DB.batch(statements);
        return json({ok:true,removed:true},200,cors);
      }

      if (request.method === "GET" && path === "/api/activity/comments") {
        const activityId=cleanText(url.searchParams.get("activity_id"),64);
        const activity=await env.DB.prepare("SELECT id FROM driver_activity WHERE id=? AND community_id=? AND status='approved'").bind(activityId,user.community_id).first();
        if(!activity)return fail("Aviso no encontrado.",404,cors);
        const result=await env.DB.prepare("SELECT c.id,c.profile_id,c.body,c.created_at,p.nickname FROM activity_comments c JOIN profiles p ON p.id=c.profile_id WHERE c.activity_id=? ORDER BY c.created_at ASC LIMIT 200").bind(activityId).all();
        return json({comments:result.results||[]},200,cors);
      }

      if (request.method === "POST" && path === "/api/activity/comments") {
        const input=await bodyJson(request),activityId=cleanText(input?.activity_id,64),body=cleanText(input?.body,1000);
        const activity=await env.DB.prepare("SELECT id FROM driver_activity WHERE id=? AND community_id=? AND status='approved'").bind(activityId,user.community_id).first();
        if(!activity||!body)return fail("Aviso o mensaje inválido.",400,cors);
        const commentId=id();
        await env.DB.prepare("INSERT INTO activity_comments(id,activity_id,profile_id,body,created_at) VALUES(?,?,?,?,?)").bind(commentId,activityId,user.profile_id,body,now()).run();
        return json({id:commentId},201,cors);
      }

      const activityAudioMatch = path.match(/^\/api\/activity\/([0-9a-f-]{36})\/audio$/i);
      if (request.method === "GET" && activityAudioMatch) {
        const row = await env.DB.prepare("SELECT audio_mime_type,audio_data,status,profile_id FROM driver_activity WHERE id=? AND community_id=?").bind(activityAudioMatch[1],user.community_id).first();
        if (!row || !row.audio_data || (row.status !== "approved" && row.profile_id !== user.profile_id && !["owner","moderator"].includes(user.role))) return fail("Audio no disponible.",404,cors);
        return new Response(row.audio_data,{status:200,headers:{...cors,"content-type":row.audio_mime_type,"cache-control":"private, max-age=300","x-content-type-options":"nosniff"}});
      }

      if (request.method === "POST" && path === "/api/reactions") {
        const input = await bodyJson(request);
        const postId = cleanText(input?.post_id, 64);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=? AND status='approved'").bind(postId, user.community_id).first();
        if (!post) return fail("Publicación no encontrada.", 404, cors);
        const existing = await env.DB.prepare("SELECT post_id FROM reactions WHERE post_id=? AND profile_id=? AND reaction='like'").bind(postId, user.profile_id).first();
        if (existing) await env.DB.prepare("DELETE FROM reactions WHERE post_id=? AND profile_id=? AND reaction='like'").bind(postId, user.profile_id).run();
        else await env.DB.prepare("INSERT INTO reactions(post_id,profile_id,reaction,created_at) VALUES(?,?,'like',?)").bind(postId, user.profile_id, now()).run();
        return json({ liked: !existing }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/route/status") {
        const result = await env.DB.prepare(
          `SELECT s.profile_id,s.status,s.location_label,'' AS note,s.updated_at,s.expires_at,p.nickname,p.avatar_key,p.avatar_media_id
           FROM route_status s JOIN profiles p ON p.id=s.profile_id
           WHERE s.community_id=? AND s.expires_at>? ORDER BY s.updated_at DESC LIMIT 100`
        ).bind(user.community_id, now()).all();
        return json({ statuses: result.results || [] }, 200, cors);
      }

      if (request.method === "PUT" && path === "/api/route/status") {
        const input = await bodyJson(request);
        const status = cleanText(input?.status, 20);
        if (!["libre", "cargando", "cargado", "descargando", "demorado", "accidente", "deposito", "planta", "base", "casa", "descansando", "cafe", "ypf", "repostando"].includes(status)) return fail("Estado inválido.", 400, cors);
        const timestamp = now(), expires = new Date(Date.now() + 86400000).toISOString();
        await env.DB.prepare(
          `INSERT INTO route_status(profile_id,community_id,status,location_label,note,updated_at,expires_at)
           VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET community_id=excluded.community_id,status=excluded.status,
           location_label=excluded.location_label,note=excluded.note,updated_at=excluded.updated_at,expires_at=excluded.expires_at`
        ).bind(user.profile_id, user.community_id, status, cleanText(input?.location, 100) || null, "", timestamp, expires).run();
        return json({ ok: true, expires_at: expires }, 200, cors);
      }

      // Optional route-status descriptions are reviewed separately from the automatic wall post.
      if (request.method === "POST" && path === "/api/route/status/description") {
        const input = await bodyJson(request);
        const postId = cleanText(input?.post_id, 64);
        const body = cleanText(input?.body, 500);
        const mediaId = cleanText(input?.media_id, 64) || null;
        if (!postId || (!body && !mediaId)) return fail("Escribí un detalle o adjuntá una imagen.", 400, cors);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=? AND profile_id=? AND deleted_at IS NULL").bind(postId,user.community_id,user.profile_id).first();
        if (!post) return fail("No encontramos el aviso original para adjuntar el detalle.",404,cors);
        if (mediaId) {
          const media = await env.DB.prepare("SELECT id FROM media WHERE id=? AND community_id=? AND profile_id=?").bind(mediaId,user.community_id,user.profile_id).first();
          if (!media) return fail("La imagen no está disponible.",400,cors);
        }
        const descriptionId=id();
        try {
          await env.DB.prepare("INSERT INTO route_status_descriptions(id,community_id,profile_id,post_id,body,media_id,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)")
            .bind(descriptionId,user.community_id,user.profile_id,postId,body,mediaId,now()).run();
        } catch {
          return fail("Este aviso ya tiene un detalle enviado a revisión.",409,cors);
        }
        return json({id:descriptionId,status:"pending"},201,cors);
      }

      if (request.method === "GET" && path === "/api/moderation/route-descriptions") {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para moderar descripciones.",403,cors);
        const result=await env.DB.prepare(
          `SELECT d.id,d.body,d.media_id,d.created_at,p.body AS original_body,
                  pr.nickname
           FROM route_status_descriptions d
           JOIN posts p ON p.id=d.post_id AND p.community_id=d.community_id
           JOIN profiles pr ON pr.id=d.profile_id
           WHERE d.community_id=? AND d.status='pending' AND p.deleted_at IS NULL
           ORDER BY d.created_at ASC LIMIT 100`
        ).bind(user.community_id).all();
        return json({descriptions:result.results||[]},200,cors);
      }

      const routeDescriptionMatch=path.match(/^\/api\/moderation\/route-descriptions\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && routeDescriptionMatch) {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para moderar descripciones.",403,cors);
        const input=await bodyJson(request);
        if (!["approve","reject"].includes(input?.action)) return fail("Acción de moderación inválida.",400,cors);
        const description=await env.DB.prepare("SELECT * FROM route_status_descriptions WHERE id=? AND community_id=? AND status='pending'").bind(routeDescriptionMatch[1],user.community_id).first();
        if(!description)return fail("La descripción ya fue revisada o no existe.",404,cors);
        if(input.action==="approve"){
          const post=await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=? AND profile_id=? AND deleted_at IS NULL").bind(description.post_id,user.community_id,description.profile_id).first();
          if(!post)return fail("El aviso original ya no está disponible; no se modificó nada.",404,cors);
          await env.DB.batch([
            env.DB.prepare("UPDATE posts SET body=CASE WHEN ?='' THEN body WHEN body='' THEN ? ELSE body || char(10) || char(10) || ? END,media_id=COALESCE(media_id,?) WHERE id=? AND community_id=? AND profile_id=? AND deleted_at IS NULL")
              .bind(description.body,description.body,description.body,description.media_id,description.post_id,user.community_id,description.profile_id),
            env.DB.prepare("UPDATE route_status_descriptions SET status='approved',moderated_by_profile_id=?,moderated_at=?,rejection_reason=NULL WHERE id=? AND community_id=? AND status='pending'")
              .bind(user.profile_id,now(),description.id,user.community_id)
          ]);
        } else {
          await env.DB.prepare("UPDATE route_status_descriptions SET status='rejected',moderated_by_profile_id=?,moderated_at=?,rejection_reason=? WHERE id=? AND community_id=? AND status='pending'")
            .bind(user.profile_id,now(),cleanText(input?.reason,240)||"El detalle no cumple las normas de convivencia.",description.id,user.community_id).run();
        }
        return json({ok:true,status:input.action==="approve"?"approved":"rejected"},200,cors);
      }

      if (request.method === "GET" && path === "/api/route/alerts") {
        const result = await env.DB.prepare(
          `SELECT a.id,a.kind,a.road,a.location_label,a.body,a.created_at,a.expires_at,p.nickname
           FROM route_alerts a JOIN profiles p ON p.id=a.profile_id
           WHERE a.community_id=? AND a.expires_at>? ORDER BY a.created_at DESC LIMIT 60`
        ).bind(user.community_id, now()).all();
        return json({ alerts: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/route/alerts") {
        const input = await bodyJson(request);
        const kind = cleanText(input?.kind, 20), body = cleanText(input?.body, 1000);
        if (!["accidente", "demora", "corte", "clima", "ruta", "otro"].includes(kind) || !body) return fail("Completá el tipo y el detalle del aviso.", 400, cors);
        const alertId = id(), timestamp = now(), expires = new Date(Date.now() + 12 * 3600000).toISOString();
        await env.DB.prepare("INSERT INTO route_alerts(id,community_id,profile_id,kind,road,location_label,body,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .bind(alertId, user.community_id, user.profile_id, kind, cleanText(input?.road, 80) || null, cleanText(input?.location, 100) || null, body, timestamp, expires).run();
        return json({ id: alertId, expires_at: expires }, 201, cors);
      }

      if (request.method === "POST" && path === "/api/media") {
        const form = await request.formData(), file = form.get("file");
        if (!file || typeof file.arrayBuffer !== "function") return fail("Falta la imagen.", 400, cors);
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return fail("Formato no permitido. Usá JPG, PNG o WebP.", 415, cors);
        if (file.size > 1024 * 1024) return fail("La imagen supera 1 MB. Reducila antes de subirla.", 413, cors);
        const mediaId = id(), bytes = new Uint8Array(await file.arrayBuffer());
        if (!bytes.byteLength) return fail("La imagen llegó vacía al servidor; no se guardó.", 400, cors);
        await env.DB.prepare("INSERT INTO media(id,community_id,profile_id,mime_type,data,created_at) VALUES(?,?,?,?,?,?)")
          .bind(mediaId, user.community_id, user.profile_id, file.type, bytes, now()).run();
        return json({ media_id: mediaId, bytes: bytes.byteLength }, 201, cors);
      }

      const mediaMatch = path.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && mediaMatch) {
        const row = await env.DB.prepare("SELECT mime_type,data,length(data) AS byte_length FROM media WHERE id=? AND community_id=?").bind(mediaMatch[1], user.community_id).first();
        if (!row) return fail("Imagen no encontrada.", 404, cors);
        const storedBytes = Number(row.byte_length || 0);
        const bytes = row.data instanceof ArrayBuffer
          ? new Uint8Array(row.data)
          : ArrayBuffer.isView(row.data)
            ? new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength)
            : new Uint8Array(row.data || 0);
        if (!storedBytes || !bytes.byteLength) return fail("La imagen existe, pero quedó guardada sin contenido (0 bytes).", 500, cors);
        if (bytes.byteLength !== storedBytes) return fail("La imagen quedó incompleta en la base de datos: se esperaban " + storedBytes + " bytes y se recuperaron " + bytes.byteLength + ".", 500, cors);
        return new Response(bytes, { status: 200, headers: { ...cors, "content-type": row.mime_type, "content-length": String(bytes.byteLength), "x-media-bytes": String(bytes.byteLength), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
      }

      if (request.method === "GET" && path === "/api/comment-notices") {
        const result=await env.DB.prepare("SELECT id,reason,created_at FROM comment_removal_notices WHERE recipient_profile_id=? AND community_id=? AND seen_at IS NULL ORDER BY created_at DESC LIMIT 20").bind(user.profile_id,user.community_id).all();
        if(result.results?.length) await env.DB.prepare("UPDATE comment_removal_notices SET seen_at=? WHERE recipient_profile_id=? AND community_id=? AND seen_at IS NULL").bind(now(),user.profile_id,user.community_id).run();
        return json({notices:result.results||[]},200,cors);
      }

      const commentDeleteMatch=path.match(/^\/api\/comments\/([0-9a-f-]{36})$/i);
      if(request.method==="DELETE" && commentDeleteMatch){
        if(user.role!=="owner")return fail("Solo el administrador puede retirar comentarios.",403,cors);
        const comment=await env.DB.prepare("SELECT c.id,c.profile_id FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=? AND p.community_id=? AND p.status='approved'").bind(commentDeleteMatch[1],user.community_id).first();
        if(!comment)return fail("Comentario no encontrado.",404,cors);
        const reason=cleanText((await bodyJson(request))?.reason,240)||"incumplía las normas de convivencia";
        const statements=[env.DB.prepare("DELETE FROM comments WHERE id=?").bind(comment.id)];
        if(comment.profile_id!==user.profile_id)statements.push(env.DB.prepare("INSERT INTO comment_removal_notices(id,community_id,recipient_profile_id,reason,created_at) VALUES(?,?,?,?,?)").bind(id(),user.community_id,comment.profile_id,reason,now()));
        await env.DB.batch(statements);
        return json({ok:true,removed:true},200,cors);
      }

      if (request.method === "GET" && path === "/api/comments") {
        const postId = cleanText(url.searchParams.get("post_id"), 64);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=? AND status='approved'").bind(postId, user.community_id).first();
        if (!post) return fail("Publicación no encontrada.", 404, cors);
        const result = await env.DB.prepare("SELECT c.id,c.profile_id,c.body,c.created_at,p.nickname FROM comments c JOIN profiles p ON p.id=c.profile_id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT 100").bind(postId).all();
        return json({ comments: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/comments") {
        const input = await bodyJson(request);
        const postId = cleanText(input?.post_id, 64), body = cleanText(input?.body, 1000);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=? AND status='approved'").bind(postId, user.community_id).first();
        if (!post || !body) return fail("Publicación o comentario inválido.", 400, cors);
        const commentId = id();
        await env.DB.prepare("INSERT INTO comments(id,post_id,profile_id,body,created_at) VALUES(?,?,?,?,?)").bind(commentId, postId, user.profile_id, body, now()).run();
        return json({ id: commentId }, 201, cors);
      }

      if (request.method === "GET" && path === "/api/messages") {
        const other = cleanText(url.searchParams.get("with"), 64);
        if (!other) return fail("Falta el compañero de la conversación.", 400, cors);
        const linked = await env.DB.prepare("SELECT 1 AS ok FROM friend_links WHERE profile_id=? AND friend_profile_id=?").bind(user.profile_id, other).first();
        if (!linked) return fail("Los mensajes privados están disponibles entre compañeros vinculados.", 403, cors);
        const result = await env.DB.prepare(
          `SELECT m.id,m.sender_profile_id,m.recipient_profile_id,m.body,m.created_at,m.read_at,p.nickname AS sender_nickname
           FROM messages m JOIN profiles p ON p.id=m.sender_profile_id
           WHERE m.community_id=? AND ((m.sender_profile_id=? AND m.recipient_profile_id=?) OR (m.sender_profile_id=? AND m.recipient_profile_id=?))
           ORDER BY m.created_at ASC LIMIT 200`
        ).bind(user.community_id, user.profile_id, other, other, user.profile_id).all();
        await env.DB.prepare("UPDATE messages SET read_at=? WHERE sender_profile_id=? AND recipient_profile_id=? AND read_at IS NULL").bind(now(), other, user.profile_id).run();
        return json({ messages: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/messages") {
        const input = await bodyJson(request);
        const recipient = cleanText(input?.recipient_profile_id, 64), body = cleanText(input?.body, 4000);
        if (!recipient || !body) return fail("Completá el mensaje.", 400, cors);
        const linked = await env.DB.prepare("SELECT 1 AS ok FROM friend_links WHERE profile_id=? AND friend_profile_id=?").bind(user.profile_id, recipient).first();
        const target = await env.DB.prepare("SELECT id FROM profiles WHERE id=? AND community_id=?").bind(recipient, user.community_id).first();
        if (!linked || !target) return fail("Solo podés escribir a compañeros vinculados.", 403, cors);
        const messageId = id();
        await env.DB.prepare("INSERT INTO messages(id,community_id,sender_profile_id,recipient_profile_id,body,created_at) VALUES(?,?,?,?,?,?)").bind(messageId, user.community_id, user.profile_id, recipient, body, now()).run();
        return json({ id: messageId }, 201, cors);
      }

      return fail("Ruta no encontrada.", 404, cors);
    } catch (error) {
      return json({ error: "Error interno del servidor.", detail: env.ENVIRONMENT === "development" ? String(error?.message || error) : undefined }, 500, cors);
    }
  }
};
