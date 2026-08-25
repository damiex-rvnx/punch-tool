// Service worker for Clock-Bot
// Handles push notifications (iOS APNs via VAPID Web Push) and
// fallback setTimeout-based scheduling (Android background).

self.addEventListener('push', evt => {
  let data = {}
  try { data = evt.data?.json() ?? {} } catch {}

  evt.waitUntil(
    self.registration.showNotification(data.title || 'Clock-Bot', {
      body:              data.body  || '',
      icon:              data.icon  || '/icon-192.png',
      badge:             '/icon-192.png',
      tag:               data.tag   || 'qr-notif',
      renotify:          true,
      requireInteraction: false,
    })
  )
})

self.addEventListener('notificationclick', evt => {
  evt.notification.close()
  evt.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) return c.focus()
      }
      return clients.openWindow('/')
    })
  )
})

// Android fallback: setTimeout-based background notifications via SW message
const _pending = new Map()

self.addEventListener('message', evt => {
  if (!evt.data) return

  if (evt.data.type === 'QR_SCHEDULE') {
    _pending.forEach(t => clearTimeout(t))
    _pending.clear()
    evt.data.items.forEach(({ id, ms, label, emoji }) => {
      const t = setTimeout(() => {
        self.registration.showNotification('Clock-Bot', {
          body:    `${emoji}  ${label}`,
          icon:    '/icon-192.png',
          badge:   '/icon-192.png',
          tag:     id,
          renotify: true,
        })
        _pending.delete(id)
      }, ms)
      _pending.set(id, t)
    })
  }

  if (evt.data.type === 'QR_CANCEL') {
    _pending.forEach(t => clearTimeout(t))
    _pending.clear()
  }
})
