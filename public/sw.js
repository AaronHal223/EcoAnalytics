// Service worker: makes EcoAnalytics installable and opens instantly.
// The app shell (this site's own files) is served from cache and refreshed in
// the background, so a new deploy shows up on the next visit. Soil and weather
// lookups go straight to the network (the page caches those results itself).

const CACHE = "eco-shell-v2";
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest",
  "./js/app.js", "./js/net.js", "./js/geo.js", "./js/soil.js", "./js/climate.js", "./js/economics.js", "./js/data.js",
  "./vendor/lp-solver.js", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;  // APIs: network only
  // Stale-while-revalidate for our own files.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => cached);
    return cached || fresh;
  }));
});
