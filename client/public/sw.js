// Field Ledger direction: offline resilience supports the field workflow without hiding the sync state.
const CACHE_NAME = "field-ledger-shell-v3";
const BOOTSTRAP_PATH = "/api/v1/driver/bootstrap";

self.addEventListener("install", (event) => {
  const scope = self.registration.scope;
  const appShell = [scope, new URL("manifest.webmanifest", scope).toString()];
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(appShell)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("sync", (event) => {
  if (event.tag !== "rovaya-inspection-sync") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      clients.forEach((client) => client.postMessage({ type: "rovaya-background-sync" }));
    }),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // Fleet list + checklist: answer instantly from the phone's copy and refresh it in the background, so
  // opening the app on a weak signal costs no waiting (and the Cloudflare edge answers the refresh).
  if (url.pathname === BOOTSTRAP_PATH) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        const refresh = fetch(event.request).then((response) => { if (response.ok) cache.put(event.request, response.clone()); return response; });
        if (cached) { event.waitUntil(refresh.catch(() => undefined)); return cached; }
        return refresh.catch(() => new Response(JSON.stringify({ error: "You are offline." }), { status: 503, headers: { "content-type": "application/json" } }));
      }),
    );
    return;
  }

  // Everything else that is not part of this app (admin API calls with sign-in tokens, signed photo links,
  // Supabase sign-in) is never stored by the service worker.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match(self.registration.scope))),
  );
});
