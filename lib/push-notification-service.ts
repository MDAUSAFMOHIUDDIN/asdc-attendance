// Client-side Push Notification Service
import { VAPID_PUBLIC_KEY } from './push-config';
import { NotificationItem } from './types';
import { db } from './firebase';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
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

    // Persist subscription in backend / Firestore
    const response = await fetch('/api/notifications/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid,
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent,
      }),
    });

    if (!response.ok) {
      console.warn('[Push] Backend subscription registration failed:', await response.text());
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

    await fetch(`/api/notifications/subscribe?uid=${encodeURIComponent(uid)}`, {
      method: 'DELETE',
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
  callback: (notifications: NotificationItem[]) => void
): () => void {
  try {
    const notifsRef = collection(db, 'notifications');
    const q = query(notifsRef, orderBy('createdAt', 'desc'), limit(50));

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
        callback(items);
      },
      (error) => {
        console.warn('[Notifications] Firestore listener error:', error);
      }
    );

    return unsubscribe;
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
