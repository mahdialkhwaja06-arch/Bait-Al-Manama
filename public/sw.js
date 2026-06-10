// Bait Al-Manama — Service Worker for Web Push Notifications

self.addEventListener('push', function(event) {
  event.waitUntil(
    fetch('/api/push-latest?t=' + Date.now())
      .then(function(r) { return r.json(); })
      .then(function(d) {
        return self.registration.showNotification(d.title || 'Bait Al-Manama', {
          body: d.body || 'Tap to open',
          icon: 'https://raw.githubusercontent.com/mahdialkhwaja06-arch/bait-almanama/main/public/logo.png',
          badge: 'https://raw.githubusercontent.com/mahdialkhwaja06-arch/bait-almanama/main/public/logo.png',
          vibrate: [300, 100, 300, 100, 300],
          tag: 'bam-notif',
          renotify: true,
          requireInteraction: false,
        });
      })
      .catch(function() {
        return self.registration.showNotification('Bait Al-Manama', {
          body: 'New activity — tap to open',
          vibrate: [300, 100, 300],
          tag: 'bam-notif',
          renotify: true,
        });
      })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});
