'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      // Register service worker after window load to prevent delaying initial page render
      const register = async () => {
        try {
          const reg = await navigator.serviceWorker.register('/sw.js', {
            scope: '/',
          });

          // Check for service worker updates periodically
          reg.addEventListener('updatefound', () => {
            const installingWorker = reg.installing;
            if (installingWorker) {
              installingWorker.addEventListener('statechange', () => {
                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[ASDC PWA] New update available; reloading or skipWaiting');
                  installingWorker.postMessage({ type: 'SKIP_WAITING' });
                }
              });
            }
          });
        } catch (error) {
          console.warn('[ASDC PWA] Service worker registration error:', error);
        }
      };

      if (document.readyState === 'complete') {
        register();
      } else {
        window.addEventListener('load', register);
        return () => window.removeEventListener('load', register);
      }
    }
  }, []);

  return null;
}
