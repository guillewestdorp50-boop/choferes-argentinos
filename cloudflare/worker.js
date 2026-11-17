const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();
const BADGE_CATALOG = [{"key":"rueda_nueva","name":"Rueda Nueva","description":"Primeros pasos y adaptación a la vida camionera."},{"key":"volante_firme","name":"Volante Firme","description":"Experiencia, responsabilidad y criterio al volante."},{"key":"kilometro_de_oro","name":"Kilómetro de Oro","description":"Trayectoria y constancia demostradas en la ruta."},{"key":"senor_de_las_rutas","name":"Señor de las Rutas","description":"Referente respetado por su experiencia y conducta."},{"key":"mano_camionera","name":"Mano Camionera","description":"Ayuda concreta y compañerismo con otros camioneros."},{"key":"ojo_rutero","name":"Ojo Rutero","description":"Avisos de ruta útiles, oportunos y comprobados."},{"key":"rey_de_la_noche","name":"Rey de la Noche","description":"Experiencia y responsabilidad en recorridos nocturnos."},{"key":"mecanico_de_emergencia","name":"Mecánico de Emergencia","description":"Conocimientos y asistencia mecánica que ayudan en ruta."},{"key":"companero_solidario","name":"Compañero Solidario","description":"Apoyo real a colegas ante una necesidad."},{"key":"veterano_del_volante","name":"Veterano del Volante","description":"Años de oficio y experiencia camionera reconocida."},{"key":"carga_segura","name":"Carga Segura","description":"Compromiso demostrado con el cuidado de la carga y la seguridad."}];
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
    `SELECT d.id AS device_id, d.last_seen_at, p.id AS profile_id, p.community_id, p.nickname, p.role, p.bio, p.avatar_key
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
  const maxUses = kind === "community" ? 45 : 1;
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

      if (request.method === "POST" && path === "/api/bootstrap") {
        const secret = request.headers.get("X-Setup-Secret") || "";
        if (!env.SETUP_SECRET || secret !== env.SETUP_SECRET) return fail("Configuración no autorizada.", 401, cors);
        const input = await bodyJson(request);
        const communityName = cleanText(input?.community_name || "Choferes Argentinos", 80);
        const nickname = cleanText(input?.nickname, 32);
        if (nickname.length < 2) return fail("El apodo debe tener al menos 2 caracteres.", 400, cors);
        const existing = await env.DB.prepare("SELECT id FROM communities LIMIT 1").first();
        if (existing) return fail("La comunidad ya fue inicializada.", 409, cors);
        const communityId = id(), profileId = id(), timestamp = now();
        const inviteCode = makeCode(), token = makeToken();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO communities(id,name,created_at) VALUES(?,?,?)").bind(communityId, communityName, timestamp),
          env.DB.prepare("INSERT INTO profiles(id,community_id,nickname,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)").bind(profileId, communityId, nickname, timestamp, timestamp),
          env.DB.prepare("INSERT INTO devices(id,profile_id,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)").bind(id(), profileId, await sha256(token), timestamp, timestamp),
          env.DB.prepare("INSERT INTO invites(id,community_id,code_hash,kind,created_by_profile_id,max_uses,uses,expires_at,created_at) VALUES(?,?,?,'community',?,45,0,?,?)").bind(id(), communityId, await sha256(inviteCode), profileId, new Date(Date.now() + 30 * 86400000).toISOString(), timestamp)
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
        const invite = await consumeInvite(env, code, ["community", "friend"]);
        if (!invite) return fail("Código inválido, vencido o ya utilizado.", 400, cors);
        const profileId = id(), timestamp = now(), token = makeToken();
        const stmts = [
          env.DB.prepare("INSERT INTO profiles(id,community_id,nickname,role,created_at,updated_at) VALUES(?,?,?,'member',?,?)").bind(profileId, invite.community_id, nickname, timestamp, timestamp),
          env.DB.prepare("INSERT INTO devices(id,profile_id,token_hash,created_at,last_seen_at) VALUES(?,?,?,?,?)").bind(id(), profileId, await sha256(token), timestamp, timestamp)
        ];
        if (invite.kind === "friend" && invite.created_by_profile_id) {
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(profileId, invite.created_by_profile_id, timestamp));
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO friend_links(profile_id,friend_profile_id,created_at) VALUES(?,?,?)").bind(invite.created_by_profile_id, profileId, timestamp));
        }
        await env.DB.batch(stmts);
        return json({ token, profile: { id: profileId, nickname, role: "member", community_id: invite.community_id } }, 201, cors);
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

      if (request.method === "GET" && path === "/api/me") return json({ profile: user }, 200, cors);
      if (request.method === "GET" && path === "/api/badges/catalog") {
        return json({ badges: BADGE_CATALOG, levels: BADGE_LEVELS }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/badges") {
        const targetId = cleanText(url.searchParams.get("profile_id") || user.profile_id, 64);
        const target = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.bio,p.role,p.avatar_key,
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
           WHERE p.community_id=? AND p.status='pending'
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
          "UPDATE posts SET status=?,moderated_by_profile_id=?,moderated_at=? WHERE id=? AND community_id=? AND status='pending'"
        ).bind(status, user.profile_id, now(), moderationMatch[1], user.community_id).run();
        if (!result.success || result.meta.changes !== 1) return fail("La publicación ya no está pendiente o no existe.", 404, cors);
        return json({ ok: true, status }, 200, cors);
      }

      if (request.method === "PATCH" && path === "/api/profile") {
        const input = await bodyJson(request);
        const nickname = cleanText(input?.nickname, 32);
        const bio = cleanText(input?.bio, 160);
        const avatarKey = cleanText(input?.avatar_key || user.avatar_key || "truck", 24);
        const allowedAvatars = ["truck","truck2","tractor","wheel","road","gear","flag","fuel","wrench","construction","pickup","bus"];
        if (nickname.length < 2) return fail("El apodo debe tener al menos 2 caracteres.", 400, cors);
        if (!allowedAvatars.includes(avatarKey)) return fail("Avatar no válido.", 400, cors);
        await env.DB.prepare("UPDATE profiles SET nickname=?,bio=?,avatar_key=?,updated_at=? WHERE id=? AND community_id=?")
          .bind(nickname, bio, avatarKey, now(), user.profile_id, user.community_id).run();
        return json({ ok: true, nickname, bio, avatar_key: avatarKey }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/invites") {
        const input = await bodyJson(request);
        const kind = input?.kind;
        if (!["friend", "device", "community"].includes(kind)) return fail("Tipo de invitación inválido.", 400, cors);
        if (kind === "community" && !["owner", "moderator"].includes(user.role)) return fail("Solo un administrador puede crear invitaciones de comunidad.", 403, cors);
        const invite = await createInvite(env, user.community_id, kind, user.profile_id, kind === "device" ? user.profile_id : null);
        return json(invite, 201, cors);
      }

      if (request.method === "GET" && path === "/api/friends") {
        const result = await env.DB.prepare(
          `SELECT p.id,p.nickname,p.bio,p.avatar_key,
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
          `SELECT p.id,p.profile_id,p.body,p.media_id,p.created_at,pr.nickname,pr.avatar_key,
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

      const postMatch = path.match(/^\\/api\\/posts\\/([0-9a-f-]{36})$/i);
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
                  pr.nickname,pr.avatar_key
           FROM driver_activity a JOIN profiles pr ON pr.id=a.profile_id
           WHERE a.community_id=? AND a.status='approved'
           ORDER BY a.created_at DESC LIMIT 100`
        ).bind(user.community_id).all();
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

      const activityModerationMatch = path.match(/^\\/api\\/moderation\\/activity\\/([0-9a-f-]{36})$/i);
      if (request.method === "PATCH" && activityModerationMatch) {
        if (!["owner","moderator"].includes(user.role)) return fail("No tenés permiso para moderar avisos del PAD.",403,cors);
        const input = await bodyJson(request);
        if (!["approve","reject"].includes(input?.action)) return fail("Acción de moderación inválida.",400,cors);
        const status = input.action === "approve" ? "approved" : "rejected";
        const result = await env.DB.prepare(
          "UPDATE driver_activity SET status=?,moderated_by_profile_id=?,moderated_at=?,rejection_reason=? WHERE id=? AND community_id=? AND status='pending'"
        ).bind(status,user.profile_id,now(),status === "rejected" ? cleanText(input?.reason,240) || "El aviso necesita algunos cambios para cumplir las normas de convivencia." : null,activityModerationMatch[1],user.community_id).run();
        if (!result.success || result.meta.changes !== 1) return fail("El aviso ya no está pendiente o no existe.",404,cors);
        return json({ok:true,status},200,cors);
      }

      const activityAudioMatch = path.match(/^\\/api\\/activity\\/([0-9a-f-]{36})\\/audio$/i);
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
          `SELECT s.profile_id,s.status,s.location_label,s.note,s.updated_at,s.expires_at,p.nickname
           FROM route_status s JOIN profiles p ON p.id=s.profile_id
           WHERE s.community_id=? AND s.expires_at>? ORDER BY s.updated_at DESC LIMIT 100`
        ).bind(user.community_id, now()).all();
        return json({ statuses: result.results || [] }, 200, cors);
      }

      if (request.method === "PUT" && path === "/api/route/status") {
        const input = await bodyJson(request);
        const status = cleanText(input?.status, 20);
        if (!["libre", "cargando", "cargado", "descargando"].includes(status)) return fail("Estado inválido.", 400, cors);
        const timestamp = now(), expires = new Date(Date.now() + 86400000).toISOString();
        await env.DB.prepare(
          `INSERT INTO route_status(profile_id,community_id,status,location_label,note,updated_at,expires_at)
           VALUES(?,?,?,?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET community_id=excluded.community_id,status=excluded.status,
           location_label=excluded.location_label,note=excluded.note,updated_at=excluded.updated_at,expires_at=excluded.expires_at`
        ).bind(user.profile_id, user.community_id, status, cleanText(input?.location, 100) || null, cleanText(input?.note, 500), timestamp, expires).run();
        return json({ ok: true, expires_at: expires }, 200, cors);
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
        await env.DB.prepare("INSERT INTO media(id,community_id,profile_id,mime_type,data,created_at) VALUES(?,?,?,?,?,?)")
          .bind(mediaId, user.community_id, user.profile_id, file.type, bytes, now()).run();
        return json({ media_id: mediaId }, 201, cors);
      }

      const mediaMatch = path.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && mediaMatch) {
        const row = await env.DB.prepare("SELECT mime_type,data FROM media WHERE id=? AND community_id=?").bind(mediaMatch[1], user.community_id).first();
        if (!row) return fail("Imagen no encontrada.", 404, cors);
        return new Response(row.data, { status: 200, headers: { ...cors, "content-type": row.mime_type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
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
