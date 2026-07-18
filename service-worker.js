// Basit service worker: uygulamanın telefonda "ana ekrana ekle" ile
// gerçek bir uygulama gibi açılabilmesi için gereklidir.
// Veriler Firestore'dan canlı geldiği için burada agresif bir
// önbellekleme yapılmıyor; sadece uygulama kabuğu (shell) önbelleğe alınır.

const CACHE_NAME = "yap-dostum-shell-v1";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Sadece kendi kabuk dosyalarımız için basit "önce ağ, olmazsa önbellek" stratejisi.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // Firebase/CDN isteklerine dokunma

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
