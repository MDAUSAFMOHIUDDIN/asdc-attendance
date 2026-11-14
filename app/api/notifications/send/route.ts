import { NextRequest, NextResponse } from 'next/server';
import { SOLE_ADMIN_EMAIL } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { doc, setDoc, collection, getDocs, getDoc, deleteDoc } from 'firebase/firestore';
import * as webPush from 'web-push';
import { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } from '@/lib/push-config';
import { NotificationItem, PushSubscriptionRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

let vapidConfigured = false;
function ensureVapidConfigured() {
  if (!vapidConfigured) {
    try {
      webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      vapidConfigured = true;
    } catch (e) {
      console.warn('[Notifications] VAPID configuration notice:', e);
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    ensureVapidConfigured();
    const body = await request.json();
    const {
      adminEmail,
      title,
      message,
      category = 'GENERAL',
      recipientUid = 'ALL',
      recipientName = 'All Students',
      url = '/',
    } = body;

    // 1. Strict Sole Admin Authorization
    if (!adminEmail || adminEmail.toLowerCase().trim() !== SOLE_ADMIN_EMAIL.toLowerCase().trim()) {
      return NextResponse.json(
        { error: 'Unauthorized: Only the sole ASDC administrator can broadcast notifications.' },
        { status: 403 }
      );
    }

    // 2. Validate input
    if (!title || title.trim().length < 3) {
      return NextResponse.json({ error: 'Title must be at least 3 characters.' }, { status: 400 });
    }
    if (!message || message.trim().length < 5) {
      return NextResponse.json({ error: 'Message must be at least 5 characters.' }, { status: 400 });
    }

    // 3. Persist notification in Firestore
    const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const notificationRecord: NotificationItem = {
      id: notificationId,
      title: title.trim(),
      message: message.trim(),
      category,
      recipientUid,
      recipientName,
      createdAt: new Date().toISOString(),
      createdBy: adminEmail.toLowerCase().trim(),
      readBy: [],
      url,
    };

    const notifRef = doc(db, 'notifications', notificationId);
    await setDoc(notifRef, notificationRecord);

    // 4. Retrieve target Push Subscriptions
    const subscriptions: PushSubscriptionRecord[] = [];
    try {
      if (recipientUid === 'ALL') {
        const subSnap = await getDocs(collection(db, 'push_subscriptions'));
        subSnap.forEach((docSnap) => {
          subscriptions.push(docSnap.data() as PushSubscriptionRecord);
        });
      } else {
        const singleSubDoc = await getDoc(doc(db, 'push_subscriptions', recipientUid));
        if (singleSubDoc.exists()) {
          subscriptions.push(singleSubDoc.data() as PushSubscriptionRecord);
        }
      }
    } catch (fetchSubErr) {
      console.warn('[Notifications] Could not fetch subscriptions from Firestore:', fetchSubErr);
    }

    // 5. Send Web Push to subscribers
    const pushPayload = JSON.stringify({
      title: notificationRecord.title,
      body: notificationRecord.message,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      url: notificationRecord.url || '/',
      tag: notificationRecord.id,
    });

    let deliveredCount = 0;
    const deliveryPromises = subscriptions.map(async (sub) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.keys.p256dh,
              auth: sub.keys.auth,
            },
          },
          pushPayload
        );
        deliveredCount++;
      } catch (pushErr: any) {
        // If subscription is expired (410) or not found (404), clean it up
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          try {
            await deleteDoc(doc(db, 'push_subscriptions', sub.uid));
          } catch (cleanErr) {
            console.warn('[Notifications] Error cleaning up expired sub:', cleanErr);
          }
        } else {
          console.warn(`[Notifications] Web push failed for user ${sub.uid}:`, pushErr.message);
        }
      }
    });

    await Promise.allSettled(deliveryPromises);

    return NextResponse.json({
      success: true,
      message: `Notification sent successfully to ${recipientName}. Delivered to ${deliveredCount} active device(s).`,
      notification: notificationRecord,
      deliveredCount,
      targetSubscribers: subscriptions.length,
    });
  } catch (error: any) {
    console.error('[Notifications] Send notification error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to send notification.' },
      { status: 500 }
    );
  }
}
