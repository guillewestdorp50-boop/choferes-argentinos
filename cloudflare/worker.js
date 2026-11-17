const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const encoder = new TextEncoder();

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
    "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
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
    `SELECT d.id AS device_id, d.last_seen_at, p.id AS profile_id, p.community_id, p.nickname, p.role, p.bio
     FROM devices d JOIN profiles p ON p.id=d.profile_id
     WHERE d.token_hash=? AND d.revoked_at IS NULL LIMIT 1`
  ).bind(tokenHash).first();
  if (row && Date.now() - Date.parse(row.last_seen_at) > 300000) {
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

      if (request.method === "PATCH" && path === "/api/profile") {
        const input = await bodyJson(request);
        const nickname = cleanText(input?.nickname, 32);
        const bio = cleanText(input?.bio, 160);
        if (nickname.length < 2) return fail("El apodo debe tener al menos 2 caracteres.", 400, cors);
        await env.DB.prepare("UPDATE profiles SET nickname=?,bio=?,updated_at=? WHERE id=? AND community_id=?")
          .bind(nickname, bio, now(), user.profile_id, user.community_id).run();
        return json({ ok: true, nickname, bio }, 200, cors);
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
          `SELECT p.id,p.nickname,p.bio FROM friend_links f JOIN profiles p ON p.id=f.friend_profile_id
           WHERE f.profile_id=? AND p.community_id=? ORDER BY p.nickname LIMIT 200`
        ).bind(user.profile_id, user.community_id).all();
        return json({ friends: result.results || [] }, 200, cors);
      }

      if (request.method === "GET" && path === "/api/posts") {
        const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit") || 40)));
        const result = await env.DB.prepare(
          `SELECT p.id,p.profile_id,p.body,p.media_id,p.created_at,pr.nickname,
             (SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id AND r.reaction='like') AS likes,
             EXISTS(SELECT 1 FROM reactions r WHERE r.post_id=p.id AND r.profile_id=? AND r.reaction='like') AS liked_by_me
           FROM posts p JOIN profiles pr ON pr.id=p.profile_id
           WHERE p.community_id=? ORDER BY p.created_at DESC LIMIT ?`
        ).bind(user.profile_id, user.community_id, limit).all();
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
        await env.DB.prepare("INSERT INTO posts(id,community_id,profile_id,body,media_id,created_at) VALUES(?,?,?,?,?,?)")
          .bind(postId, user.community_id, user.profile_id, body, mediaId, now()).run();
        return json({ id: postId }, 201, cors);
      }

      if (request.method === "POST" && path === "/api/reactions") {
        const input = await bodyJson(request);
        const postId = cleanText(input?.post_id, 64);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=?").bind(postId, user.community_id).first();
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
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=?").bind(postId, user.community_id).first();
        if (!post) return fail("Publicación no encontrada.", 404, cors);
        const result = await env.DB.prepare("SELECT c.id,c.profile_id,c.body,c.created_at,p.nickname FROM comments c JOIN profiles p ON p.id=c.profile_id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT 100").bind(postId).all();
        return json({ comments: result.results || [] }, 200, cors);
      }

      if (request.method === "POST" && path === "/api/comments") {
        const input = await bodyJson(request);
        const postId = cleanText(input?.post_id, 64), body = cleanText(input?.body, 1000);
        const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND community_id=?").bind(postId, user.community_id).first();
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
