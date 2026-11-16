import { NextRequest, NextResponse } from 'next/server';
import { SOLE_ADMIN_EMAIL } from '@/lib/admin-config';
import { FIREBASE_CONFIG } from '@/lib/firebase';
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

/**
 * Verify Firebase Auth ID token and ensure caller is the authorized sole administrator
 */
async function verifyAdminIdToken(idToken: string): Promise<{ authorized: boolean; email?: string; error?: string }> {
  try {
    const apiKey = FIREBASE_CONFIG.apiKey;
    if (!apiKey) {
      return { authorized: false, error: 'Firebase API key is not configured.' };
    }

    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      return { authorized: false, error: `Invalid or expired administrator token: ${errText}` };
    }

    const data = await res.json();
    const user = data.users?.[0];
    if (!user || !user.email) {
      return { authorized: false, error: 'No user account found for provided token.' };
    }

    const normalizedEmail = user.email.toLowerCase().trim();
    const authorizedEmail = SOLE_ADMIN_EMAIL.toLowerCase().trim();

    if (normalizedEmail !== authorizedEmail) {
      return {
        authorized: false,
        email: normalizedEmail,
        error: `Unauthorized: Only ${SOLE_ADMIN_EMAIL} can send broadcast push notifications.`,
      };
    }

    return { authorized: true, email: normalizedEmail };
  } catch (err: any) {
    return { authorized: false, error: `Token verification failed: ${err.message || String(err)}` };
  }
}

/**
 * Save notification record to Firestore via authenticated REST API
 * Supports standard createDocument (POST ?documentId=...) and PATCH fallback
 */
async function saveNotificationToFirestore(
  notification: NotificationItem,
  idToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const projectId = FIREBASE_CONFIG.projectId;

    const fieldsPayload = {
      fields: {
        id: { stringValue: notification.id },
        title: { stringValue: notification.title },
        message: { stringValue: notification.message },
        category: { stringValue: notification.category },
        recipientUid: { stringValue: notification.recipientUid },
        recipientName: { stringValue: notification.recipientName },
        createdAt: { stringValue: notification.createdAt },
        createdBy: { stringValue: notification.createdBy },
        url: { stringValue: notification.url || '/' },
        readBy: { arrayValue: { values: [] } },
      },
    };

    // 1. Primary: Attempt creation via standard REST createDocument (POST .../notifications?documentId=...)
    const createUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/notifications?documentId=${encodeURIComponent(notification.id)}`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fieldsPayload),
    });

    if (createRes.ok) {
      return { success: true };
    }

    // HTTP 409 Conflict: Document already exists in Firestore (e.g. written by client setDoc)
    if (createRes.status === 409) {
      return { success: true };
    }

    // 2. Secondary: Fallback to PATCH (upsert / update)
    const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/notifications/${encodeURIComponent(notification.id)}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(fieldsPayload),
    });

    if (patchRes.ok) {
      return { success: true };
    }

    const errText = await patchRes.text();
    return { success: false, error: `Firestore notification write rejected: ${errText}` };
  } catch (err: any) {
    return { success: false, error: err.message || 'Network error saving notification to Firestore.' };
  }
}

/**
 * Retrieve push subscriptions from Firestore via authenticated REST API
 */
async function fetchPushSubscriptions(
  idToken: string,
  recipientUid: string
): Promise<{ subscriptions: PushSubscriptionRecord[]; error?: string }> {
  try {
    const projectId = FIREBASE_CONFIG.projectId;

    if (recipientUid !== 'ALL') {
      // Targeted single student subscription
      const singleUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/push_subscriptions/${recipientUid}`;
      const res = await fetch(singleUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${idToken}` },
      });

      if (!res.ok) {
        if (res.status === 404) return { subscriptions: [] };
        const errText = await res.text();
        return { subscriptions: [], error: `Failed to fetch student subscription: ${errText}` };
      }

      const docData = await res.json();
      const fields = docData.fields || {};
      const endpoint = fields.endpoint?.stringValue;
      const p256dh = fields.keys?.mapValue?.fields?.p256dh?.stringValue;
      const authKey = fields.keys?.mapValue?.fields?.auth?.stringValue;

      if (endpoint && p256dh && authKey) {
        return {
          subscriptions: [
            {
              uid: recipientUid,
              endpoint,
              keys: { p256dh, auth: authKey },
              userAgent: fields.userAgent?.stringValue,
              updatedAt: fields.updatedAt?.stringValue,
            },
          ],
        };
      }
      return { subscriptions: [] };
    }

    // Broadcast: Retrieve all subscriptions with maximum page size
    const listUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/push_subscriptions?pageSize=300`;
    const res = await fetch(listUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      return { subscriptions: [], error: `Failed to query push subscriptions: ${errText}` };
    }

    const data = await res.json();
    const docs = data.documents || [];
    const subscriptions: PushSubscriptionRecord[] = [];

    for (const d of docs) {
      const fields = d.fields || {};
      const uid = fields.uid?.stringValue || d.name?.split('/').pop() || '';
      const endpoint = fields.endpoint?.stringValue;
      const p256dh = fields.keys?.mapValue?.fields?.p256dh?.stringValue;
      const authKey = fields.keys?.mapValue?.fields?.auth?.stringValue;

      if (uid && endpoint && p256dh && authKey) {
        subscriptions.push({
          uid,
          endpoint,
          keys: { p256dh, auth: authKey },
          userAgent: fields.userAgent?.stringValue,
          updatedAt: fields.updatedAt?.stringValue,
        });
      }
    }

    return { subscriptions };
  } catch (err: any) {
    return { subscriptions: [], error: err.message || 'Error fetching subscriptions from database.' };
  }
}

/**
 * Clean up invalid or expired subscription from Firestore
 */
async function removeExpiredSubscription(uid: string, idToken: string): Promise<void> {
  try {
    const projectId = FIREBASE_CONFIG.projectId;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/push_subscriptions/${uid}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    console.log(`[Notifications] Cleaned up expired push subscription for user ${uid}`);
  } catch (cleanErr) {
    console.warn('[Notifications] Expired subscription cleanup note:', cleanErr);
  }
}

export async function POST(request: NextRequest) {
  try {
    ensureVapidConfigured();

    // 1. Extract Bearer token from header or body
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    let idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const body = await request.json();
    if (!idToken && body.idToken) {
      idToken = body.idToken;
    }

    if (!idToken) {
      return NextResponse.json(
        {
          error:
            'Authentication Required: Administrator session token was not provided. Please ensure you are logged into Firebase as the administrator.',
        },
        { status: 401 }
      );
    }

    // 2. Authenticate & Authorize Administrator on Trusted Backend
    const authResult = await verifyAdminIdToken(idToken);
    if (!authResult.authorized) {
      return NextResponse.json(
        { error: authResult.error || `Unauthorized: Only ${SOLE_ADMIN_EMAIL} can broadcast notifications.` },
        { status: 403 }
      );
    }

    const {
      title,
      message,
      category = 'GENERAL',
      recipientUid = 'ALL',
      recipientName = 'All Students',
      url = '/',
      existingNotificationId,
      clientSaved = false,
    } = body;

    // 3. Input validation with meaningful error messages
    if (!title || typeof title !== 'string' || title.trim().length < 3) {
      return NextResponse.json(
        { error: 'Invalid title: Notification title must be at least 3 characters long.' },
        { status: 400 }
      );
    }
    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      return NextResponse.json(
        { error: 'Invalid message: Notification message body must be at least 5 characters long.' },
        { status: 400 }
      );
    }

    // 4. Prepare schema-compliant NotificationItem
    const notificationId =
      existingNotificationId && /^[a-zA-Z0-9_\-]+$/.test(existingNotificationId)
        ? existingNotificationId
        : `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const notificationRecord: NotificationItem = {
      id: notificationId,
      title: title.trim(),
      message: message.trim(),
      category,
      recipientUid,
      recipientName,
      createdAt: new Date().toISOString(),
      createdBy: SOLE_ADMIN_EMAIL.toLowerCase().trim(),
      readBy: [],
      url: url || '/',
    };

    // 5. Persist notification to Firestore via authenticated REST API
    if (clientSaved) {
      // Document was already written directly by the authenticated admin in the client session
      // Run idempotent REST sync in background without blocking dispatch
      saveNotificationToFirestore(notificationRecord, idToken).catch((err) => {
        console.warn('[Notifications] Background REST sync note:', err);
      });
    } else {
      const saveResult = await saveNotificationToFirestore(notificationRecord, idToken);
      if (!saveResult.success) {
        console.error('[Notifications] Database save failed:', saveResult.error);
        return NextResponse.json(
          { error: `Database error: Could not save notification to Firestore: ${saveResult.error}` },
          { status: 500 }
        );
      }
    }

    // 6. Retrieve registered students' valid push subscriptions
    const { subscriptions, error: subError } = await fetchPushSubscriptions(idToken, recipientUid);
    if (subError) {
      console.warn('[Notifications] Subscription fetch notice:', subError);
    }

    // 7. Dispatch High-Priority Push Notifications via Firebase Cloud Messaging / Web Push
    const origin = process.env.NEXT_PUBLIC_APP_URL || 'https://asdc-attendance-tktz.vercel.app';
    const absoluteIcon = `${origin}/asdc-logo.png`;
    const absoluteBadge = `${origin}/icons/icon-192.png`;
    const targetUrl = notificationRecord.url?.startsWith('http')
      ? notificationRecord.url
      : `${origin}${notificationRecord.url || '/'}`;

    const pushPayload = JSON.stringify({
      id: notificationRecord.id,
      title: notificationRecord.title,
      body: notificationRecord.message,
      icon: absoluteIcon,
      badge: absoluteBadge,
      image: absoluteIcon,
      url: targetUrl,
      tag: notificationRecord.id,
      category: notificationRecord.category,
      silent: false,
      vibrate: [200, 100, 200],
      // FCM compatibility structure
      notification: {
        title: notificationRecord.title,
        body: notificationRecord.message,
        icon: absoluteIcon,
        click_action: targetUrl,
      },
      data: {
        id: notificationRecord.id,
        title: notificationRecord.title,
        body: notificationRecord.message,
        url: targetUrl,
        category: notificationRecord.category,
      },
    });

    const pushOptions = {
      TTL: 86400, // 24-hour persistence if device is offline
      urgency: 'high' as const, // High urgency wakes up device from Doze mode like WhatsApp
      topic: 'asdc_broadcast',
      headers: {
        Urgency: 'high',
      },
    };

    let deliveredCount = 0;
    let expiredCount = 0;

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
          pushPayload,
          pushOptions
        );
        deliveredCount++;
      } catch (pushErr: any) {
        // HTTP 410 (Gone), 404 (Not Found), or 403 (mismatched/unregistered key)
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404 || pushErr.statusCode === 403) {
          expiredCount++;
          await removeExpiredSubscription(sub.uid, idToken!);
        } else {
          console.warn(`[Notifications] Web push failed for user ${sub.uid}:`, pushErr.message);
        }
      }
    });

    await Promise.allSettled(deliveryPromises);

    return NextResponse.json({
      success: true,
      message:
        recipientUid === 'ALL'
          ? `Broadcast notification dispatched successfully. Delivered to ${deliveredCount} active student device(s).`
          : `Notification sent successfully to ${recipientName}. Delivered to ${deliveredCount} device(s).`,
      notification: notificationRecord,
      deliveredCount,
      targetSubscribers: subscriptions.length,
      expiredCleanedUp: expiredCount,
    });
  } catch (error: any) {
    console.error('[Notifications] Dispatch error:', error);
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred while sending notification.' },
      { status: 500 }
    );
  }
}
