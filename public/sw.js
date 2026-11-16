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

// Real Web Push & FCM Notifications Handler with Native OS Sound & Deduplication
self.addEventListener('push', (event) => {
  const origin = self.location.origin;
  const defaultIcon = new URL('/asdc-logo.png', origin).href;
  const defaultBadge = new URL('/icons/icon-192.png', origin).href;

  let data = {
    id: `notif_${Date.now()}`,
    title: 'ASDC Attendance Notification',
    body: 'New official update from ASDC administration.',
    url: '/',
    icon: defaultIcon,
    badge: defaultBadge,
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      // Support standard WebPush, FCM notification, and FCM data payloads
      const notifObj = parsed.notification || {};
      const dataObj = parsed.data || {};

      const rawIcon = notifObj.icon || notifObj.image || dataObj.icon || parsed.icon || data.icon;
      const rawBadge = notifObj.badge || dataObj.badge || parsed.badge || data.badge;
      const rawUrl = parsed.url || dataObj.url || notifObj.click_action || parsed.click_action || '/';

      data = {
        ...data,
        ...parsed,
        id: parsed.id || dataObj.id || data.id,
        title: notifObj.title || dataObj.title || parsed.title || data.title,
        body: notifObj.body || dataObj.body || parsed.body || data.body,
        icon: rawIcon ? (rawIcon.startsWith('http') ? rawIcon : new URL(rawIcon, origin).href) : defaultIcon,
        badge: rawBadge ? (rawBadge.startsWith('http') ? rawBadge : new URL(rawBadge, origin).href) : defaultBadge,
        url: rawUrl ? (rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, origin).href) : new URL('/', origin).href,
      };
    } catch {
      const text = event.data.text();
      if (text) data.body = text;
    }
  }

  const notificationTag = data.tag || data.id || 'asdc_broadcast';

  const options = {
    body: data.body,
    icon: data.icon || defaultIcon,
    badge: data.badge || defaultBadge,
    image: data.icon || defaultIcon,
    silent: false, // Explicitly false to trigger native OS notification sound
    renotify: true, // Alerts the user even if an older notification with the same tag exists
    tag: notificationTag, // Prevents duplicate notification stacking
    vibrate: [200, 100, 200], // Tactile alert on supported mobile devices
    requireInteraction: false,
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

  // 1. Notify all active foreground client windows to update in-app UI and chime
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
    })
    .catch((err) => console.warn('[ASDC SW] Client notification note:', err));

  // 2. Display native operating system notification with resilient fallback
  const displayNotificationPromise = (async () => {
    try {
      await self.registration.showNotification(data.title, options);
    } catch (showErr) {
      console.warn('[ASDC SW] showNotification with actions failed, retrying without actions:', showErr);
      const safeOptions = {
        body: options.body,
        icon: options.icon,
        badge: options.badge,
        silent: false,
        renotify: true,
        tag: notificationTag,
        vibrate: [200, 100, 200],
        data: options.data,
      };
      try {
        await self.registration.showNotification(data.title, safeOptions);
      } catch (finalErr) {
        console.error('[ASDC SW] Failed to show system notification:', finalErr);
      }
    }
  })();

  event.waitUntil(Promise.all([notifyClientsPromise, displayNotificationPromise]));
});

// Notification Click Handler: Focus app or open URL
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') {
    return;
  }

  const origin = self.location.origin;
  const rawUrl = event.notification.data?.url || '/';
  const targetUrl = rawUrl.startsWith('http') ? rawUrl : new URL(rawUrl, origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open on our origin, focus it
      for (const client of clientList) {
        if (client.url && client.url.startsWith(origin) && 'focus' in client) {
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            notificationId: event.notification.data?.id,
          });
          return client.focus();
        }
      }
      // Otherwise open a new window to the target URL
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
