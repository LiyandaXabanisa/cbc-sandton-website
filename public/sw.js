// Service worker: lets the site open instantly and work without a connection.
//
// What it does
//   * Pages and scripts: always try the network first, so a new release shows up straight away.
//     If the network is slow (4 seconds) or missing, the last saved copy is used instead.
//   * Images: served from the saved copy first, because they almost never change.
//   * Anything else is left alone: the database, logins, payment pages and other websites
//     are never saved or touched by this file.
//
// To force every phone to drop its saved copies after a release, change VERSION below.

const VERSION = "v2";
const CACHE = "cbc-sandton-" + VERSION;
const OFFLINE_PAGE = "offline.html";

// Small set saved on first visit so the home page opens offline.
const PRECACHE = [
  "./",
  "index.html",
  OFFLINE_PAGE,
  "styles.css",
  "script.js",
  "api.js",
  "site.config.js",
  "manifest.webmanifest",
  "assets/emblem.svg",
  "assets/fonts/archivo-var.woff2",
  "assets/fonts/fraunces-roman-500.woff2",
  "assets/fonts/fraunces-italic-500.woff2",
  "assets/fonts/jetbrains-mono-var.woff2",
  "assets/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("cbc-sandton-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(request, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const useCache = () =>
      caches.match(request, { ignoreSearch: true }).then((hit) => {
        if (settled) return;
        settled = true;
        resolve(hit || null);
      });
    const timer = setTimeout(useCache, timeoutMs);
    fetch(request)
      .then((response) => {
        clearTimeout(timer);
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        if (!settled) {
          settled = true;
          resolve(response);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        useCache();
      });
  });
}

function cacheFirst(request) {
  return caches.match(request).then(
    (hit) =>
      hit ||
      fetch(request).then((response) => {
        if (response && response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // other websites and the database: not ours
  if (url.pathname.includes("/api/")) return; // the local demo server: never saved

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, 4000).then(
        (response) => response || caches.match(OFFLINE_PAGE).then((page) => page || Response.error())
      )
    );
    return;
  }

  if (request.destination === "image" || request.destination === "font") {
    event.respondWith(cacheFirst(request).catch(() => Response.error()));
    return;
  }

  event.respondWith(networkFirst(request, 4000).then((response) => response || Response.error()));
});
