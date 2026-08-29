// ============================================================
// MUTASSO PRO v6.2 — sw.js (Service Worker PWA)
// Stratégie :
//  - Coquille de l'appli + CDN : pré-mise en cache à l'install
//  - Navigations : réseau d'abord, repli sur la copie cachée
//    (l'appli s'ouvre hors ligne)
//  - Ressources statiques : cache d'abord + mise à jour en arrière-plan
//  - API /api/* : toujours réseau (données à jour), jamais caché
// ============================================================
const CACHE = 'mutasso-v3';

const SHELL = [
  '/',
  '/index.html',
  '/gas-bridge.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

const CDN = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap'
];

// Installation : pré-cache tolérant (un CDN indisponible n'empêche pas l'install)
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled([...SHELL, ...CDN].map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

// Activation : purge des anciennes versions de cache
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.filter(n => n.startsWith('mutasso-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Données de l'application : réseau uniquement (jamais de données périmées)
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Navigation (ouverture de l'appli) : réseau d'abord, repli hors ligne
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const rep = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/index.html', rep.clone());
        return rep;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match('/index.html')) || (await cache.match('/')) ||
          new Response('<h1>Hors ligne</h1><p>MUTASSO nécessite une connexion au premier lancement.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Ressources statiques (JS, CSS, polices, icônes, CDN) :
  // cache d'abord, rafraîchissement discret en arrière-plan
  event.respondWith((async () => {
    const enCache = await caches.match(req, { ignoreSearch: url.origin === self.location.origin && url.pathname === '/' });
    const majArrierePlan = fetch(req).then(rep => {
      if (rep && (rep.ok || rep.type === 'opaque')) {
        const copie = rep.clone();
        caches.open(CACHE).then(c => c.put(req, copie));
      }
      return rep;
    }).catch(() => null);
    if (enCache) return enCache;
    const rep = await majArrierePlan;
    if (rep) return rep;
    return new Response('', { status: 504, statusText: 'Hors ligne' });
  })());
});

/* ============ NOTIFICATIONS PUSH ============ */
// Réception d'une notification émise par le serveur (VAPID)
self.addEventListener('push', (event) => {
  let donnees = {};
  try { donnees = event.data ? event.data.json() : {}; }
  catch (e) { donnees = { title: 'MUTASSO', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(donnees.title || 'MUTASSO', {
    body: donnees.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: donnees.tag || 'mutasso',
    data: { url: donnees.url || '/' }
  }));
});

// Clic sur la notification : ouvre (ou focalise) l'application
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenetres) {
      if ('focus' in f) { f.navigate(url).catch(() => {}); return f.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
