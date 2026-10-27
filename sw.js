// Offline support: every app file is cached on install and served cache-first.
// The PDF reader (vendor/) and ISIN map (data/) are large and only needed for CAS imports, so they are
// cached the first time they are used instead. Bump VERSION whenever any of these files change.
const VERSION = 'wt-v3';
const LAZY = /\/(vendor|data)\//;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'js/app.js',
  'js/core/assets.js',
  'js/core/backup.js',
  'js/core/calendar.js',
  'js/core/cas.js',
  'js/core/demat.js',
  'js/core/categories.js',
  'js/core/draft.js',
  'js/core/fixedIncome.js',
  'js/core/format.js',
  'js/core/ics.js',
  'js/core/mfapi.js',
  'js/core/ppf.js',
  'js/core/seed.js',
  'js/store/crypto.js',
  'js/store/db.js',
  'js/store/store.js',
  'js/ui/dom.js',
  'js/ui/donut.js',
  'js/ui/html.js',
  'js/ui/icons.js',
  'js/ui/pdf.js',
  'js/views/assets.js',
  'js/views/casImport.js',
  'js/views/common.js',
  'js/views/dashboard.js',
  'js/views/detail.js',
  'js/views/form.js',
  'js/views/gate.js',
  'js/views/rates.js',
  'js/views/settings.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache so a new version never precaches stale files.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // NAV lookups (mfapi.in) and anything else off-site go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      // Every page URL is the same single-page app.
      const cached = await cache.match(request.mode === 'navigate' ? 'index.html' : request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && LAZY.test(url.pathname)) await cache.put(request, response.clone());
      return response;
    })(),
  );
});
