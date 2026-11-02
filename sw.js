// Service worker – offline režim. Při každé změně souborů zvyš číslo verze!
const CACHE = 'aktivita-v1.0.0';
const SHELL = ['./', './index.html', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-180.png',
  './lib/leaflet.css',
  './lib/leaflet.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.includes('firestore.googleapis.com')) return; // data vždy živě
  if (u.hostname.includes('basemaps.cartocdn.com')) { // mapové dlaždice: cache-first
    e.respondWith(caches.open('aktivita-tiles').then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { c.put(e.request, n.clone()); return n; }))));
    return;
  }
  // aplikace: nejdřív síť (aktuální verze), offline z cache
  e.respondWith(fetch(e.request).then(n => { const cp = n.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return n; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
