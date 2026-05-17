// OneSignal service worker — import their SDK via Cloudflare proxy (iOS PWA blocks cdn.onesignal.com directly)
importScripts("https://qr-clock-bot.lbrito1126.workers.dev/sw-sdk.js");

// Map of pending setTimeout IDs keyed by reminder id
const _pending = new Map();

self.addEventListener('message', evt => {
  if (!evt.data) return;

  if (evt.data.type === 'QR_SCHEDULE') {
    // Clear any previously scheduled
    _pending.forEach(t => clearTimeout(t));
    _pending.clear();

    evt.data.items.forEach(({ id, ms, label, emoji }) => {
      const t = setTimeout(() => {
        self.registration.showNotification('QR Clock-Bot', {
          body: `${emoji}  ${label}`,
          icon: '/qwik-crew-clock/icon-192.png',
          badge: '/qwik-crew-clock/icon-192.png',
          tag: id,
          renotify: true,
          requireInteraction: false,
        });
        _pending.delete(id);
      }, ms);
      _pending.set(id, t);
    });
  }

  if (evt.data.type === 'QR_CANCEL') {
    _pending.forEach(t => clearTimeout(t));
    _pending.clear();
  }
});

// When user taps the notification, focus the app if already open
self.addEventListener('notificationclick', evt => {
  evt.notification.close();
  evt.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('qwik-crew-clock') && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/qwik-crew-clock/');
    })
  );
});
