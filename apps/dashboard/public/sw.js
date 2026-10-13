/*
 * The CRM's service worker - what makes it installable as an app, and open
 * quickly from the home screen.
 *
 * What it keeps on the phone is only the app itself: the built files under
 * /assets (their names change with every release, so a cached one is never
 * stale), the icons and the logo. The page is always fetched fresh when
 * there is a connection, so a new release shows on the next open; the cached
 * copy is only used when there is none. Data - orders, stock, everything
 * from Supabase - is on another origin and never touched here: it is always
 * live.
 */

// Bump this when an icon or the logo changes: those are kept until it does.
const CACHE = 'duch-app-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/logo-black.png', '/favicon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only our own files. Supabase, fonts and anything else go straight to the network.
  if (url.origin !== self.location.origin) return;

  // Pages: fresh from the network, so a release shows at once; the cached
  // shell only when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/').then((cached) => cached || Response.error())),
    );
    return;
  }

  // Built files carry a hash in their name: once fetched, they never change.
  // Top-level files only (the icons, the logo), so nothing under /supabase -
  // the data proxy a local build uses (lib/supabase.ts) - can ever be cached.
  if (url.pathname.startsWith('/assets/') || /^\/[^/]+\.(png|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
