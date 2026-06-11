// GPX Navigator Pro — Service Worker
// Versão do cache: incrementar ao atualizar os arquivos
const CACHE = "gpx-nav-v31-dev";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap"
];

// Instalação: pré-cachear recursos essenciais
self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // Tenta cachear cada asset, ignora falhas individuais
      return Promise.allSettled(ASSETS.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

// Ativação: remover caches antigos
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first para assets locais, network-first para tiles do mapa
self.addEventListener("fetch", e => {
  // Só GET e http(s) — cache.put lança erro com POST/chrome-extension://
  if (e.request.method !== "GET" || !e.request.url.startsWith("http")) return;
  const url = e.request.url;

  // Tiles do mapa: sempre tenta rede, fallback para cache
  // (basemaps.cartocdn.com — o match antigo "carto.com" nunca casava)
  if (url.includes("cartocdn") || url.includes("carto.com") || url.includes("openstreetmap")) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Demais recursos: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
