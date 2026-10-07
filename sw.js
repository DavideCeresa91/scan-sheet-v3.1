const PREFIX = 'scan-sheet:' + new URL(self.registration.scope).pathname + ':';
const CACHE = PREFIX + 'v3.1.0';
const FILES = ['./','./index.html','./style.css','./app.js','./storage.js','./transport.js','./config.js','./google-auth.js',
  './manifest.webmanifest','./vendor/zxing-browser-0.2.1.min.js','./icons/icon.svg?v=31','./icons/ceresa-cherry.svg',
  './icons/icon-192.png?v=31','./icons/icon-512.png?v=31','./icons/maskable-512.png?v=31','./icons/apple-touch-icon.png?v=31'];
const urls = new Set(FILES.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(path => new Request(path, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  // Cache only local app assets. OAuth/Picker and user data always use the network.
  const assetURL = new URL(event.request.url);
  assetURL.hash = '';
  if (event.request.method !== 'GET' || !urls.has(assetURL.href)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(assetURL.href)) || fetch(event.request)));
});
