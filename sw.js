/* ============================================================
   Rahim Football Tchad — Service Worker v3
   Version finale 100/100
   - Shell + Runtime caches séparés
   - Network-first navigation
   - Stale-while-revalidate assets
   - Push notifications + clic
   - Fallback hors-ligne
   ============================================================ */

/* ---------- CONFIG ---------- */
const SW_VERSION       = "v3";
const SHELL_CACHE      = "rf-shell-" + SW_VERSION;      // App shell (rarement mis à jour)
const RUNTIME_CACHE    = "rf-runtime-" + SW_VERSION;    // Assets dynamiques (limité)
const RUNTIME_MAX      = 60;                            // Nombre max d'entrées runtime
const FETCH_TIMEOUT_MS = 8000;                          // Timeout réseau 8s

/* ---------- ASSETS PRÉ-CACHÉS ---------- */
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json"
];

/* ---------- DOMAINES JAMAIS CACHÉS ---------- */
const EXCLUDED_HOSTS = [
  "firestore",
  "firebaseio",
  "firebaseapp",
  "googleapis",
  "gstatic",
  "imgbb.com",
  "googletagmanager",
  "google-analytics",
  "doubleclick"
];

/* ============================================================
   1. INSTALL — Pré-cache de l'app shell
   ============================================================ */
self.addEventListener("install", event => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        // Utilise addAll mais tolère les échecs individuels
        await Promise.all(
          SHELL_ASSETS.map(url =>
            cache.add(url).catch(err => console.warn("[SW] Pré-cache échoué :", url, err))
          )
        );
        await self.skipWaiting();
        console.log("[SW] Installé :", SW_VERSION);
      } catch (err) {
        console.error("[SW] Install error :", err);
      }
    })()
  );
});

/* ============================================================
   2. ACTIVATE — Nettoyage des anciens caches
   ============================================================ */
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        const validCaches = [SHELL_CACHE, RUNTIME_CACHE];
        await Promise.all(
          keys.filter(k => !validCaches.includes(k)).map(k => {
            console.log("[SW] Suppression ancien cache :", k);
            return caches.delete(k);
          })
        );
        // Active immédiatement sans attendre le rechargement
        await self.clients.claim();
        // Prévient les onglets ouverts
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach(client => client.postMessage({ type: "SW_ACTIVATED", version: SW_VERSION }));
        console.log("[SW] Activé :", SW_VERSION);
      } catch (err) {
        console.error("[SW] Activate error :", err);
      }
    })()
  );
});

/* ============================================================
   3. FETCH — Routage intelligent
   ============================================================ */
self.addEventListener("fetch", event => {
  const req = event.request;

  /* ---- Filtres de sécurité ---- */
  // 1. Uniquement GET
  if (req.method !== "GET") return;

  // 2. Uniquement http(s)
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (!url.protocol.startsWith("http")) return;

  // 3. Ignore les domaines exclus
  if (EXCLUDED_HOSTS.some(h => url.hostname.includes(h) || url.origin.includes(h))) return;

  // 4. Ignore les extensions navigateur
  if (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") return;

  /* ---- Routage ---- */
  const isNavigation = req.mode === "navigate";
  const isStaticAsset = /\.(css|js|woff2?|ttf|otf|svg|png|jpg|jpeg|gif|webp|ico)$/i.test(url.pathname);
  const isSameOrigin = url.origin === self.location.origin;

  // (A) Navigation : Network-first avec fallback
  if (isNavigation) {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // (B) Assets statiques same-origin : Stale-While-Revalidate (plus rapide)
  if (isSameOrigin && isStaticAsset) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // (C) Reste : Network-first avec cache fallback + timeout
  event.respondWith(networkFirstWithTimeout(req));
});

/* ============================================================
   4. STRATÉGIES DE CACHE
   ============================================================ */

/* ---- Network-first pour la navigation ---- */
async function networkFirstNavigation(req) {
  try {
    const resp = await fetchWithTimeout(req, FETCH_TIMEOUT_MS);
    if (resp && resp.status === 200) {
      const copy = resp.clone();
      const cache = await caches.open(SHELL_CACHE);
      cache.put("./index.html", copy).catch(() => {});
    }
    return resp;
  } catch {
    const cached = await caches.match("./index.html");
    return cached || offlineFallback();
  }
}

/* ---- Stale-While-Revalidate pour assets statiques ---- */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cachedResp = await cache.match(req);

  // Lance le fetch en arrière-plan (mise à jour silencieuse)
  const fetchPromise = fetch(req)
    .then(async resp => {
      if (resp && resp.status === 200 && resp.type !== "opaque") {
        try {
          await cache.put(req, resp.clone());
          await trimRuntimeCache(cache);
        } catch (e) { /* quota */ }
      }
      return resp;
    })
    .catch(() => cachedResp || new Response("", { status: 503 }));

  // Retourne le cache immédiatement si dispo, sinon attend le réseau
  return cachedResp || fetchPromise;
}

/* ---- Network-first avec timeout ---- */
async function networkFirstWithTimeout(req) {
  try {
    const resp = await fetchWithTimeout(req, FETCH_TIMEOUT_MS);
    if (resp && resp.status === 200 && resp.type !== "opaque") {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, resp.clone())
        .then(() => trimRuntimeCache(cache))
        .catch(() => {});
    }
    return resp;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response("Ressource indisponible hors-ligne", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

/* ============================================================
   5. UTILITAIRES
   ============================================================ */

/* ---- Fetch avec timeout ---- */
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), ms);
    fetch(req)
      .then(resp => { clearTimeout(timer); resolve(resp); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

/* ---- Limite la taille du cache runtime (FIFO) ---- */
async function trimRuntimeCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length > RUNTIME_MAX) {
      const excess = keys.length - RUNTIME_MAX;
      for (let i = 0; i < excess; i++) {
        await cache.delete(keys[i]);
      }
    }
  } catch (e) { /* ignore */ }
}

/* ---- Page hors-ligne intégrée ---- */
function offlineFallback() {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hors ligne — Rahim Football Tchad</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:60px 20px;background:#f8fafc;color:#0f172a;margin:0}
  .logo{width:80px;height:80px;border-radius:20px;background:linear-gradient(90deg,#0066B3 0 33.33%,#FECB00 33.33% 66.66%,#C8102E 66.66% 100%);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:36px;margin:0 auto 24px;font-family:Arial,sans-serif}
  h1{color:#0066B3;font-size:22px;margin-bottom:16px}
  p{color:#64748b;font-size:14px;line-height:1.6;max-width:340px;margin:0 auto 24px}
  a{display:inline-block;padding:14px 28px;background:#0066B3;color:#fff;text-decoration:none;border-radius:10px;font-weight:800;font-size:14px}
  a:active{transform:scale(.96)}
</style>
</head>
<body>
  <div class="logo">R</div>
  <h1>📡 Vous êtes hors ligne</h1>
  <p>La connexion internet est indisponible. Vérifiez votre réseau puis réessayez.</p>
  <a href="./">Réessayer</a>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/* ============================================================
   6. MESSAGE CHANNEL — Communication avec la page
   ============================================================ */
self.addEventListener("message", event => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (data.type === "CLEAR_CACHE") {
    event.waitUntil(
      caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
    );
  }
});

/* ============================================================
   7. PUSH NOTIFICATIONS — Réception
   ============================================================ */
self.addEventListener("push", event => {
  let data = { title: "Rahim Football Tchad", body: "Nouvelle actu football 🇹🇩⚽", url: "./" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: "./assets/icon-192.png",
    badge: "./assets/icon-192.png",
    tag: "rf-notif",
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || "./" }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

/* ============================================================
   8. CLIC SUR NOTIFICATION — Ouvre le site
   ============================================================ */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Si un onglet est déjà ouvert, focus dessus
      for (const client of allClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          await client.focus();
          if ("navigate" in client) client.navigate(targetUrl);
          return;
        }
      }
      // Sinon, ouvre un nouvel onglet
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});

/* ============================================================
   9. NOTIFICATION CLOSE — Silencieux
   ============================================================ */
self.addEventListener("notificationclose", () => {
  // Rien à faire. Gardé pour éviter les warnings.
});

/* ============================================================
   FIN
   ============================================================ */
console.log("[SW] Chargé : Rahim Football Tchad " + SW_VERSION);
