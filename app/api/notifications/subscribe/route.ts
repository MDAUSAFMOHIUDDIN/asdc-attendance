import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase';
import { doc, setDoc, deleteDoc } from 'firebase/firestore';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { uid, subscription, userAgent } = body;

    if (!uid || !subscription || !subscription.endpoint || !subscription.keys) {
      return NextResponse.json(
        { error: 'Missing required subscription fields (uid, endpoint, keys).' },
        { status: 400 }
      );
    }

    const subDoc = {
      uid,
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      userAgent: userAgent || 'unknown',
      updatedAt: new Date().toISOString(),
    };

    const docRef = doc(db, 'push_subscriptions', uid);
    await setDoc(docRef, subDoc, { merge: true });

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
    const { searchParams } = new URL(request.url);
    const uid = searchParams.get('uid');

    if (!uid) {
      return NextResponse.json({ error: 'Missing uid parameter.' }, { status: 400 });
    }

    const docRef = doc(db, 'push_subscriptions', uid);
    await deleteDoc(docRef);

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
