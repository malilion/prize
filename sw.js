/* The complete app shell is cached as one version. Bump this name whenever a shell file changes. */
const CACHE_NAME = 'prize-shell-20260927-5';
const SHELL = [
  './', 'index.html', 'verify.html', 'projection.html',
  'tokens.css', 'app.css', 'verify.css', 'projection.css',
  'js/util.js', 'js/offline.js', 'js/zip.js', 'js/evidence.js',
  'js/eligibility.js', 'js/store.js', 'js/sound.js', 'js/recorder.js',
  'js/stage.js', 'js/app.js', 'js/verify.js', 'js/projection.js',
];
const shellUrls = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(SHELL.map((path) => new Request(new URL(path, self.registration.scope).href, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    // A running draw keeps its current worker and code until every old page closes.
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('prize-shell-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !shellUrls.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(event.request) || fetch(event.request);
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'prize-shell-status' || !event.ports?.[0]) return;
  const port = event.ports[0];
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const entries = await Promise.all([...shellUrls].map((url) => cache.match(url)));
    port.postMessage({ ready: entries.every(Boolean) });
  })().catch(() => port.postMessage({ ready: false })));
});
