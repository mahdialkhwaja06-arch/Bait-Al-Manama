// Bait Al-Manama — Service Worker (Push Notifications + PWA Caching)

const CACHE = 'bam-v2';
const CACHE_PAGES = ['/staff.html', '/customer.html', '/kitchen.html', '/icon.svg'];

// ── Install: pre-cache app shell ──────────────────────────────
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return Promise.all(CACHE_PAGES.map(function(url) {
        return fetch(url).then(function(r) { if(r.ok) return c.put(url, r); }).catch(function(){});
      }));
    })
  );
});

// ── Activate: clean old caches ────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
    }).then(function(){ return self.clients.claim(); })
  );
});

// ── Fetch: network-first for API, cache-first for pages ───────
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // API requests: always network
  if (url.includes('/api/')) return;
  // Page requests: try network, fall back to cache
  if (e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request).then(function(r) {
        if (r.ok) {
          var clone = r.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return r;
      }).catch(function() {
        return caches.match(e.request).then(function(c) { return c || fetch(e.request); });
      })
    );
  }
});

// ── Push Notifications ────────────────────────────────────────
self.addEventListener('push', function(event) {
  event.waitUntil(
    fetch('/api/push-latest?t=' + Date.now())
      .then(function(r) { return r.json(); })
      .then(function(d) {
        return self.registration.showNotification(d.title || 'Bait Al-Manama', {
          body: d.body || 'Tap to open',
          icon: '/icon.svg',
          badge: '/icon.svg',
          vibrate: [300, 100, 300, 100, 300],
          tag: 'bam-notif',
          renotify: true,
          requireInteraction: false,
        });
      })
      .catch(function() {
        return self.registration.showNotification('Bait Al-Manama', {
          body: 'New activity — tap to open',
          icon: '/icon.svg',
          vibrate: [300, 100, 300],
          tag: 'bam-notif',
        });
      })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(list) {
      for (var c of list) { if (c.url.includes('/staff.html') && 'focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('/staff.html');
    })
  );
});
