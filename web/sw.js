// Bursar service worker: the console installs as an app on a phone. Network first for everything, so an update is seen
// on the next load; the last good copy of a page and its assets serves when the network is down. Nothing is stored here
// beyond the pages: keys stay in the page's own storage, the chain is always asked live.
const VERSION = "bursar-2026-11-08";
const SHELL = ["/", "/console", "/login", "/style.css", "/site.css", "/site.js", "/verify.js", "/brand/favicon.svg", "/brand/mark.svg", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return; // RPC, relay, CDN: never touched
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone())).catch(() => {}); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((c) => c || caches.match("/console"))));
});
