// Client-side Push Notification Service
import { VAPID_PUBLIC_KEY } from './push-config';
import { NotificationItem, PushSubscriptionRecord } from './types';
import { db, auth } from './firebase';
import { playNotificationChime } from './notification-audio';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  arrayUnion,
} from 'firebase/firestore';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getPushPermissionState(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  return await Notification.requestPermission();
}

export async function registerPushSubscription(uid: string): Promise<PushSubscription | null> {
  if (!isPushSupported() || !uid) return null;

  try {
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') {
      console.log('[Push] Notification permission not granted:', permission);
      return null;
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      const convertedVapidKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey as BufferSource,
      });
    }

    const subJson = subscription.toJSON();
    const endpoint = subJson.endpoint || '';
    const p256dh = subJson.keys?.p256dh || '';
    const authKey = subJson.keys?.auth || '';

    if (!endpoint || !p256dh || !authKey) {
      console.warn('[Push] Subscription keys incomplete, cannot register.');
      return subscription;
    }

    const record: PushSubscriptionRecord = {
      uid,
      endpoint,
      keys: { p256dh, auth: authKey },
      userAgent: navigator.userAgent,
      updatedAt: new Date().toISOString(),
    };

    // 1. Direct authenticated client Firestore write (guaranteed by rule request.auth.uid == subId)
    try {
      const docRef = doc(db, 'push_subscriptions', uid);
      await setDoc(docRef, record, { merge: true });
      console.log('[Push] Subscription saved directly to Firestore');
    } catch (fsErr) {
      console.warn('[Push] Direct Firestore write note:', fsErr);
    }

    // 2. Persist subscription in backend with Firebase Auth ID token
    const idToken = await auth.currentUser?.getIdToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

    const response = await fetch('/api/notifications/subscribe', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        idToken,
        uid,
        subscription: subJson,
        userAgent: navigator.userAgent,
      }),
    });

    if (!response.ok) {
      console.warn('[Push] Backend subscription registration note:', await response.text());
    } else {
      console.log('[Push] Successfully subscribed to push notifications');
    }

    return subscription;
  } catch (error) {
    console.error('[Push] Error registering push subscription:', error);
    return null;
  }
}

export async function unsubscribeFromPush(uid: string): Promise<boolean> {
  if (!isPushSupported() || !uid) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }

    // 1. Delete directly from Firestore
    try {
      await deleteDoc(doc(db, 'push_subscriptions', uid));
    } catch (e) {
      console.warn('[Push] Direct delete note:', e);
    }

    // 2. Delete via backend
    const idToken = await auth.currentUser?.getIdToken();
    const headers: Record<string, string> = {};
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

    await fetch(`/api/notifications/subscribe?uid=${encodeURIComponent(uid)}`, {
      method: 'DELETE',
      headers,
    });

    return true;
  } catch (error) {
    console.error('[Push] Error unsubscribing:', error);
    return false;
  }
}

export function subscribeToNotifications(
  userUid: string,
  isAdmin: boolean,
  callback: (notifications: NotificationItem[]) => void,
  onNewAlert?: (newItem: NotificationItem) => void
): () => void {
  try {
    const notifsRef = collection(db, 'notifications');
    const q = query(notifsRef, orderBy('createdAt', 'desc'), limit(50));
    let initialLoad = true;

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items: NotificationItem[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as NotificationItem;
          // Filter: Admin sees all; regular user sees ALL broadcasts or notifications addressed to them
          if (isAdmin || data.recipientUid === 'ALL' || data.recipientUid === userUid) {
            items.push({ ...data, id: docSnap.id });
          }
        });

        // Detect newly broadcasted notifications after initial snapshot
        if (!initialLoad) {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              const fresh = change.doc.data() as NotificationItem;
              if (isAdmin || fresh.recipientUid === 'ALL' || fresh.recipientUid === userUid) {
                const isUnread = !fresh.readBy || !fresh.readBy.includes(userUid);
                if (isUnread) {
                  playNotificationChime(change.doc.id);
                  if (onNewAlert) {
                    onNewAlert({ ...fresh, id: change.doc.id });
                  }
                }
              }
            }
          });
        }

        initialLoad = false;
        callback(items);
      },
      (error) => {
        console.warn('[Notifications] Firestore listener error:', error);
      }
    );

    // Also listen for foreground messages sent from Service Worker
    const handleServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'ASDC_NOTIFICATION_PUSH') {
        const payload = event.data.notification;
        if (payload && payload.id) {
          playNotificationChime(payload.id);
        }
      }
    };

    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }

    return () => {
      unsubscribe();
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
      }
    };
  } catch (error) {
    console.error('[Notifications] Failed to attach listener:', error);
    return () => {};
  }
}

export async function markNotificationAsRead(
  notificationId: string,
  userUid: string
): Promise<void> {
  try {
    const docRef = doc(db, 'notifications', notificationId);
    await updateDoc(docRef, {
      readBy: arrayUnion(userUid),
    });
  } catch (error) {
    console.warn('[Notifications] Failed to mark as read:', error);
  }
}

export async function markAllNotificationsAsRead(
  notificationIds: string[],
  userUid: string
): Promise<void> {
  if (!userUid || !notificationIds || notificationIds.length === 0) return;
  const promises = notificationIds.map(async (id) => {
    try {
      const docRef = doc(db, 'notifications', id);
      await updateDoc(docRef, {
        readBy: arrayUnion(userUid),
      });
    } catch (e) {
      console.warn(`[Notifications] Mark all read note for ${id}:`, e);
    }
  });
  await Promise.allSettled(promises);
}
