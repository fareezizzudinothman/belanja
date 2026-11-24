'use strict';

// Belanja service worker - static-shell caching only.
// Never caches API/auth/user data.
//
// v3: app code (HTML/JS/CSS) is served network-first with a cache fallback and
// the precache is fetched with `cache: 'reload'`.
//
// Why v3 exists: v2 precached with a plain `cache.addAll()` and then served every
// static asset cache-first. `addAll` goes through the browser's HTTP cache, and
// nginx served .js with `Cache-Control: public, max-age=3600`, so a body fetched
// BEFORE a deploy was still "fresh" and got baked into the NEW cache version -
// which was then served cache-first forever. A ui.js change therefore never
// reached an already-visited browser: the file on disk was correct, the running
// page was not (this is what hid `credit_card` from the Variable Expenses
// dropdown). Two rules prevent a repeat:
//   1. code is never served from a cache that predates a deploy, and
//   2. the precache always bypasses the HTTP cache.
// Images/fonts keep a long cache (they are safe to serve stale) and are
// refreshed in the background.
const CACHE = 'belanja-static-v3';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/dashboard.html',
  '/monthly.html',
  '/fixed-expenses.html',
  '/variable-expenses.html',
  '/installments.html',
  '/profile.html',
  '/offline.html',
  '/manifest.json',
  '/css/style.css',
  '/js/ui.js',
  '/js/dashboard.js',
  '/js/monthly.js',
  '/js/fixed-expenses.js',
  '/js/variable-expenses.js',
  '/js/installments.js',
  '/js/profile.js',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/icon-maskable-512.png',
  '/images/apple-touch-icon.png',
];

// App code: correctness matters (a stale ui.js/route is a user-visible bug), so
// it is revalidated every time and only falls back to the cache when offline.
const CODE_RE = /\.(?:html|js|css)$/;
// Fingerprint-free static assets: cheap to serve from cache, refreshed in the
// background so the next load is current.
const ASSET_RE = /\.(?:png|jpe?g|gif|svg|ico|webp|woff2?)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // `cache: 'reload'` bypasses the browser HTTP cache: the precache must
      // hold the body that is on disk right now, never a cached older one.
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('belanja-static-') && k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Network first; the cache is only the offline fallback. `cache: 'no-cache'`
// revalidates with the server (cheap 304s) so a body cached under an older
// Cache-Control policy can never be replayed.
//
// `navigationFallback` is only used for navigations: when the network is gone we
// prefer the offline notice over a cached (and now data-less) app shell.
async function networkFirst(req, navigationFallback) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }));
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (navigationFallback) {
      const fallback = await cache.match(navigationFallback);
      if (fallback) return fallback;
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

// Cache first, refresh in the background.
function staleWhileRevalidate(req) {
  return caches.open(CACHE).then((cache) =>
    cache.match(req).then((hit) => {
      const fromNetwork = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => undefined);
      if (hit) return hit;
      return fromNetwork.then((res) => res || Response.error());
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only same-origin GET requests are handled.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Never touch API/auth/user data - network only.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, fall back to the offline page when offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, '/offline.html'));
    return;
  }

  if (CODE_RE.test(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (ASSET_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // Anything else goes straight to the network (unhandled by the worker).
});
