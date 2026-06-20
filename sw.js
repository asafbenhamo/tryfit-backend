// sw.js - Service Worker for the advisor PWA.
// Its main job: receive push messages (even when the app is closed) and show a
// system notification, so the merchant feels the agent working in real time.

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate immediately on update
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Receive a push from the server and show a notification.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'היועץ החכם';
  const options = {
    body: data.body || 'יש עדכון חדש',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    vibrate: [200, 100, 200],
    tag: data.tag || 'advisor',
    renotify: true,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification opens (or focuses) the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = (event.notification.data && event.notification.data.url) || '/chat';
  // Make it an absolute URL within our origin.
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // If the advisor is already open, focus it (and navigate if possible).
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) { client.navigate(target).catch(()=>{}); }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});