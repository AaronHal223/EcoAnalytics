// Service worker: makes EcoAnalytics installable and opens instantly.
// The app shell (this site's own files) is served from cache and refreshed in
// the background, so a new deploy shows up on the next visit. Soil and weather
// lookups go straight to the network (the page caches those results itself).

const CACHE = "eco-shell-v7";
const DATA = "eco-data";            // alert settings written by the page, and alerts already shown
importScripts("alerts-core.js");
const SHELL = [
  "./", "./index.html", "./styles.css", "./manifest.webmanifest", "./alerts-core.js",
  "./js/app.js", "./js/net.js", "./js/geo.js", "./js/soil.js", "./js/climate.js", "./js/economics.js", "./js/data.js",
  "./js/planner.js", "./js/forecast.js", "./js/calibration.js", "./js/provenance.js",
  "./js/sun.js", "./js/risk.js", "./js/guide.js", "./js/share.js",
  "./js/weekly.js", "./js/trend.js", "./js/yard.js", "./js/strip.js", "./js/units.js", "./js/currency.js", "./js/i18n.js", "./js/lang-es.js",
  "./js/account.js", "./js/journal.js",
  "./vendor/lp-solver.js", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== DATA).map(k => caches.delete(k))))
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

// ---- Frost and heat alerts (no server: the phone wakes us about twice a day) ----------------
async function readJSON(key, fallback) {
  try { const r = await (await caches.open(DATA)).match(key); return r ? await r.json() : fallback; } catch { return fallback; }
}
async function writeJSON(key, value) {
  const c = await caches.open(DATA);
  await c.put(key, new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }));
}

async function checkAlerts() {
  const cfg = await readJSON("alerts-config", null);
  if (!cfg || !cfg.enabled || !Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lon)) return;
  if (self.Notification && Notification.permission !== "granted") return;
  const res = await fetch(EcoAlerts.forecastUrl(cfg.lat, cfg.lon));
  if (!res.ok) return;
  const days = EcoAlerts.parse(await res.json());
  const sent = await readJSON("alerts-sent", []);
  const alerts = EcoAlerts.alertsFor(days, cfg, sent);
  for (const a of alerts) {
    await self.registration.showNotification(a.title, { body: a.body, tag: a.id, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: "./" } });
  }
  if (alerts.length) await writeJSON("alerts-sent", [...sent, ...alerts.map(a => a.id)].slice(-60));
}

self.addEventListener("periodicsync", e => { if (e.tag === "eco-alerts") e.waitUntil(checkAlerts().catch(() => {})); });
self.addEventListener("message", e => { if (e.data === "eco-check-alerts") e.waitUntil(checkAlerts().catch(() => {})); });
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => "focus" in c);
    return open ? open.focus() : self.clients.openWindow(e.notification.data?.url || "./");
  }));
});
