const CACHE="choferes-live-v11-inline-photos";
const ASSETS=["./","./index.html","./manifest.webmanifest","./icon-192.svg","./icon-512.svg"];
self.addEventListener("install",event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  // The Cloudflare API is cross-origin and is never cached by this service worker.
  if(url.origin!==self.location.origin)return;
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}
    return response;
  })));
});

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const notification = self.registration.showNotification(payload.title || "Choferes Argentinos", {
    body: payload.body || "Hay una publicación pendiente de revisión.",
    icon: "./icon-192.svg",
    badge: "./icon-192.svg",
    tag: payload.tag || "ca-moderation-alert",
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 180, 500, 180, 850],
    data: { url: payload.url || "./?tab=moderacion", post_id: payload.post_id || null },
    actions: [{ action: "review", title: "Revisar publicación" }]
  });
  const notifyOpenApp = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(windows => {
    for (const client of windows) client.postMessage({ type: "CA_NEW_PENDING_POST", post_id: payload.post_id || null });
  });
  event.waitUntil(Promise.all([notification, notifyOpenApp]));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || "./?tab=moderacion";
  let targetUrl = new URL(rawUrl, self.location.origin);
  if (targetUrl.origin !== self.location.origin) targetUrl = new URL("./?tab=moderacion", self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async windows => {
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(targetUrl.href);
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(targetUrl.href);
  }));
});
