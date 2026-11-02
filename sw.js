// Service worker: deja la app disponible sin conexión.
// Al cambiar cualquier archivo de la app, sube VERSION para que los teléfonos actualicen.
const VERSION = 'v4';
const CACHE = `lector-${VERSION}`;
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/zip.js', 'js/epub.js', 'js/text.js',
  'js/catalog.js', 'js/settings.js', 'js/library.js', 'js/reader.js', 'js/search.js', 'js/highlights.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Archivos de la app: se sirven desde caché y se refrescan en segundo plano.
// La carpeta library/ (catálogo de libros) siempre va a la red.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/library/')) return;

  e.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: true });
    const refresh = fetch(request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      })
      .catch(() => hit || caches.match('index.html'));
    e.waitUntil(refresh);
    return hit || refresh;
  })());
});
