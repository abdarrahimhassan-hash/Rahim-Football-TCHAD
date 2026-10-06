// ============================================
// sw.js — Rahim Football Tchad
// Service Worker : notifications push + cache
// ============================================

const CACHE_NAME = "rft-v1";
const URLS_TO_CACHE = [
  "./",
  "./index.html"
];

// Installation
self.addEventListener("install", (event) => {
  console.log("[SW] Installation");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(URLS_TO_CACHE))
  );
  self.skipWaiting();
});

// Activation
self.addEventListener("activate", (event) => {
  console.log("[SW] Activation");
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// Réception push
self.addEventListener("push", (event) => {
  let data = {
    title: "Rahim Football Tchad ⚽",
    body: "Nouvelle actualité disponible !",
    url: "./"
  };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./assets/icon-192.png",
      badge: "./assets/icon-192.png",
      vibrate: [200, 100, 200],
      tag: "rft-notif",
      renotify: true,
      data: { url: data.url || "./" }
    })
  );
});

// Clic sur notification
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data.url || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes("Rahim-Football") && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Fetch (fallback réseau)
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.url.includes("firebase") || event.request.url.includes("googleapis")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
