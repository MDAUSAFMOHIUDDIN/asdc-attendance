// ASDC Attendance Production Service Worker with Web Push & Safe Caching
const CACHE_NAME = 'asdc-attendance-v2';

// Safe non-sensitive static assets to cache for offline app shell
const PRECACHE_ASSETS = [
  '/',
  '/manifest.json',
  '/asdc-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/apple-touch-icon.png',
  '/favicon-32x32.png',
  '/favicon.png',
];

// Installation: Cache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[ASDC SW] Precache partial error:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activation: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            console.log('[ASDC SW] Deleting obsolete cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-First for Navigation and API routes; Cache-First for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Strict Security Rule: NEVER cache attendance, authorization, or master-excel API requests
  if (
    url.pathname.startsWith('/api/attendance') ||
    url.pathname.startsWith('/api/notifications') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com')
  ) {
    // Pure network request without cache intervention
    return;
  }

  // Static Assets (icons, images, css, fonts)
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        return (
          cached ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const resClone = res.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
            }
            return res;
          })
        );
      })
    );
    return;
  }

  // HTML Navigation: Network-First with offline cache fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        const root = await caches.match('/');
        if (root) return root;
        return new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>ASDC Attendance Offline</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:50px;background:#f8fafc;color:#1e293b;"><h2>No Internet Connection</h2><p>Please check your connection to access the ASDC Attendance System.</p><button onclick="location.reload()" style="padding:10px 20px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;">Retry</button></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      })
    );
    return;
  }

  // Default: Network with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// Real Web Push Notifications Handler with Native OS Sound & Deduplication
self.addEventListener('push', (event) => {
  let data = {
    id: `notif_${Date.now()}`,
    title: 'ASDC Attendance Notification',
    body: 'New official update from ASDC administration.',
    url: '/',
    icon: '/asdc-logo.png',
    badge: '/icons/icon-192.png',
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data = { ...data, ...parsed };
    } catch {
      data.body = event.data.text() || data.body;
    }
  }

  const notificationTag = data.tag || data.id || 'asdc_broadcast';

  const options = {
    body: data.body,
    icon: data.icon || '/asdc-logo.png',
    badge: data.badge || '/icons/icon-192.png',
    silent: false, // Explicitly false to trigger OS notification sound
    renotify: true, // Alerts the user even if an older notification with the same tag exists
    tag: notificationTag, // Prevents duplicate notification stacking
    vibrate: [200, 100, 200], // Tactile alert on supported mobile devices
    data: {
      id: data.id,
      url: data.url || '/',
      tag: notificationTag,
      timestamp: Date.now(),
    },
    actions: [
      { action: 'open', title: 'Open ASDC App' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  // 1. Notify all active foreground client windows to update UI and play in-app chime
  const notifyClientsPromise = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windowClients) => {
      windowClients.forEach((client) => {
        client.postMessage({
          type: 'ASDC_NOTIFICATION_PUSH',
          notification: {
            ...data,
            tag: notificationTag,
          },
        });
      });
    });

  // 2. Display native operating system notification
  const showNotificationPromise = self.registration.showNotification(data.title, options);

  event.waitUntil(Promise.all([notifyClientsPromise, showNotificationPromise]));
});

// Notification Click Handler: Focus app or open URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it and navigate
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          if ('navigate' in client && targetUrl) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});

// Support manual skip-waiting trigger
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
