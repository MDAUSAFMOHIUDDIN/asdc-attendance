import { NextRequest, NextResponse } from 'next/server';
import { FIREBASE_CONFIG } from '@/lib/firebase';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    let idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const body = await request.json();
    if (!idToken && body.idToken) {
      idToken = body.idToken;
    }

    const { uid, subscription, userAgent } = body;

    if (!uid || !subscription || !subscription.endpoint || !subscription.keys) {
      return NextResponse.json(
        { error: 'Missing required subscription fields (uid, endpoint, keys).' },
        { status: 400 }
      );
    }

    const p256dh = subscription.keys.p256dh;
    const authKey = subscription.keys.auth;
    const nowIso = new Date().toISOString();

    // If ID token provided, persist to Firestore REST API with caller's authentication context
    if (idToken) {
      try {
        const projectId = FIREBASE_CONFIG.projectId;
        const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/push_subscriptions/${uid}`;
        const restRes = await fetch(restUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fields: {
              uid: { stringValue: uid },
              endpoint: { stringValue: subscription.endpoint },
              keys: {
                mapValue: {
                  fields: {
                    p256dh: { stringValue: p256dh },
                    auth: { stringValue: authKey },
                  },
                },
              },
              userAgent: { stringValue: userAgent || 'unknown' },
              updatedAt: { stringValue: nowIso },
            },
          }),
        });

        if (!restRes.ok) {
          const errText = await restRes.text();
          console.warn('[Subscribe API] Firestore REST write note:', errText);
        }
      } catch (restErr) {
        console.warn('[Subscribe API] Firestore REST write exception:', restErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Push subscription registered successfully.',
    });
  } catch (error: any) {
    console.error('[Notifications] Failed to save subscription:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to register push subscription.' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const { searchParams } = new URL(request.url);
    const uid = searchParams.get('uid');

    if (!uid) {
      return NextResponse.json({ error: 'Missing uid parameter.' }, { status: 400 });
    }

    if (idToken) {
      try {
        const projectId = FIREBASE_CONFIG.projectId;
        const restUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/push_subscriptions/${uid}`;
        await fetch(restUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${idToken}` },
        });
      } catch (restErr) {
        console.warn('[Subscribe API] Firestore REST delete note:', restErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Push subscription removed successfully.',
    });
  } catch (error: any) {
    console.error('[Notifications] Failed to remove subscription:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to remove push subscription.' },
      { status: 500 }
    );
  }
}
