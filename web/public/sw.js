// Сервис-воркер Jol: сайт открывается без сети и показывает последние загруженные места.
//
// Правила простые и осторожные, чтобы после выкладки новой версии никто не застрял на старой:
//   • страница (HTML)          — сначала сеть, без сети — сохранённая копия;
//   • файлы /assets/*          — имя содержит хэш содержимого, поэтому берём из кэша навсегда;
//   • запросы к базе Supabase  — сначала сеть, без сети — последний сохранённый ответ;
//   • плитки карты и всё прочее — не трогаем.
//
// При изменении правил увеличь номер версии: старые кэши удалятся сами.
const VERSION = 'jol-v1'
const STATIC = `${VERSION}-static`
const DATA = `${VERSION}-data`

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(caches.open(STATIC).then((cache) => cache.addAll(['/', '/favicon.svg'])))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith(VERSION)) await caches.delete(name)
    }
    await self.clients.claim()
  })())
})

async function networkFirst(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(fallbackKey ?? request, response.clone())
    return response
  } catch (error) {
    const saved = await cache.match(fallbackKey ?? request)
    if (saved) return saved
    throw error
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const saved = await cache.match(request)
  if (saved) return saved
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(cacheFirst(request, STATIC))
    } else if (request.mode === 'navigate') {
      // Сайт одностраничный: любая навигация — это та же главная страница
      event.respondWith(networkFirst(request, STATIC, '/'))
    } else {
      event.respondWith(networkFirst(request, STATIC))
    }
  } else if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/')) {
    event.respondWith(networkFirst(request, DATA))
  }
})
