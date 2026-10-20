// Service Worker 只為了讓 PWA 可安裝。
// 最高準則：完全不快取——不使用 Cache Storage，所有請求一律走網路且繞過 HTTP 快取。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req, { cache: 'no-store' }));
});
