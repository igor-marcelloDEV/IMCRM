// Minimal hand-rolled service worker — no Workbox/next-pwa. Next 16
// leans further into Turbopack and a generic PWA plugin's webpack
// assumptions are a real compatibility risk, so this stays small and
// purpose-built: (1) makes the dashboard installable, (2) caches the
// app shell as it's visited so a reload works offline, (3) leaves API
// data caching/mutation-queueing to the IndexedDB outbox
// (src/lib/offline/*) rather than intercepting API calls here —
// keeps that logic in regular, testable TypeScript instead of
// service-worker-context code.

const CACHE_NAME = "imcrm-shell-v1";
// Only ever GET, cross-origin-safe, same-origin requests are cached —
// enforced in the fetch handler below, not just by convention here.

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]).catch(() => {
        // Best-effort — a missing precache entry shouldn't block install.
      }),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // mutations are never cached
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API GETs stay live, no offline-stale data

  // Navigations (HTML page loads): network-first so staff always see
  // fresh content when online, falling back to whatever shell page was
  // last cached when offline instead of the browser's default error.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/today"))),
    );
    return;
  }

  // Static assets (_next/static chunks, icons, etc.): cache-first,
  // populating the cache the first time each hashed asset is seen —
  // there's no build-time manifest to precache against here.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
