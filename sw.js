/**
 * ================================================================
 * SW.JS — Service Worker for Risk2Rescue Citizen Portal
 * ================================================================
 * Cache-first for core app shell; network-first for live data APIs
 */

const SHELL_CACHE_NAME = 'rzi-citizen-shell-v4';
const DATA_CACHE_NAME = 'rzi-citizen-data-v4';

const APP_SHELL_URLS = [
  '/',
  '/citizen',
  '/citizen.html',
  '/css/base.css',
  '/css/citizen.css',
  '/css/simulation.css',
  '/js/land-boundary.js',
  '/js/data.js',
  '/js/map.js',
  '/js/hazards.js',
  '/js/location-service.js',
  '/js/windy-integration.js',
  '/js/citizen.js',
  '/js/simulation-engine.js',
  '/js/sos-beacon.js',
  '/js/scenarios-ui.js',
  '/js/firebase-config.js',
  '/js/firebase-live.js',
  '/js/firebase-modal.js',
  '/data/census_lookup.json',
  '/data/ap_districts_census.json',
  '/data/shelters.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then(async (cache) => {
      for (const url of APP_SHELL_URLS) {
        try {
          const res = await fetch(url, { cache: 'reload' });
          if (res.ok || res.type === 'opaque') {
            await cache.put(url, res);
          }
        } catch (e) {
          // Skip if external fails
        }
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter(k => k !== SHELL_CACHE_NAME && k !== DATA_CACHE_NAME)
            .map(k => caches.delete(k))
        );
      })
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Data endpoints: Network-first falling back to cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const clone = res.clone();
            caches.open(DATA_CACHE_NAME).then(c => c.put(request, clone).catch(() => { }));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true, timestamp: Date.now() }), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        })
    );
    return;
  }

  // 2. Navigation requests: Network-first falling back to cached shell
  if (request.mode === 'navigate' || url.pathname === '/citizen' || url.pathname === '/citizen.html') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(SHELL_CACHE_NAME).then(c => c.put(request, clone).catch(() => { }));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/citizen.html') || await caches.match('/citizen');
          if (cached) return cached;
          return new Response('Offline - Risk2Rescue', { status: 503 });
        })
    );
    return;
  }

  // 3. Static assets: Network-first falling back to cache
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          const clone = res.clone();
          caches.open(SHELL_CACHE_NAME).then(c => c.put(request, clone).catch(() => { }));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response('', { status: 408 });
      })
  );
});
