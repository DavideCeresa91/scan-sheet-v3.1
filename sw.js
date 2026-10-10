const PREFIX = 'barcode-bipper:' + new URL(self.registration.scope).pathname + ':';
const CACHE = PREFIX + 'v1.0.0';
const FILES = [
  './','./index.html','./style.css','./app.js','./storage.js','./transport.js','./config.js','./google-auth.js',
  './manifest.webmanifest','./oauth-callback.html','./vendor/zxing-browser-0.2.1.min.js',
  './icons/crs-cherry-mask.png','./icons/icon-192.png?v=100','./icons/icon-512.png?v=100',
  './icons/maskable-512.png?v=100','./icons/apple-touch-icon.png?v=100'
];
const urls = new Set(FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES.map(path => new Request(path, {cache:'reload'}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Cache solo asset locali. OAuth, Picker, Apps Script e dati utente passano sempre dalla rete.
  const assetURL = new URL(event.request.url);
  assetURL.hash = '';
  if (event.request.method !== 'GET' || !urls.has(assetURL.href)) return;
  event.respondWith(
    caches.open(CACHE).then(async cache => (await cache.match(assetURL.href)) || fetch(event.request))
  );
});
