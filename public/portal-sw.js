/* Only a public offline shell is cached. No API, media, authenticated HTML or member data. */
const PORTAL_CACHE = "b1-portal-shell-v1";
const PORTAL_SHELL = ["/portal-offline.html", "/portal-icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(PORTAL_CACHE).then(cache => cache.addAll(PORTAL_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("b1-portal-shell-") && key !== PORTAL_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate" && (url.pathname === "/portal" || url.pathname.startsWith("/portal/"))) {
    event.respondWith(fetch(event.request).catch(async () => (await caches.match("/portal-offline.html")) || Response.error()));
  } else if (PORTAL_SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
