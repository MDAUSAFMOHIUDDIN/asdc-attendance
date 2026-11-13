import { NextRequest, NextResponse } from 'next/server';
import { setQRAccessStatus } from '@/lib/qr-challenge-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';
import { QRAccessStatus } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, status, activate } = body;

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only authorized administrator (mdausafmohiuddin@gmail.com) can control QR access.' },
        { status: 403 }
      );
    }

    let targetEnabled = true;
    if (typeof body.qrAccessEnabled === 'boolean') {
      targetEnabled = body.qrAccessEnabled;
    } else if (status) {
      targetEnabled = status === 'ENABLED';
    } else if (activate !== undefined) {
      targetEnabled = Boolean(activate);
    }

    const result = await setQRAccessStatus(adminEmail, targetEnabled);

    // If admin passed Firebase Auth ID Token, also sync directly with Firestore REST API
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.split('Bearer ')[1].trim();
      if (idToken) {
        try {
          const firestoreUrl = `https://firestore.googleapis.com/v1/projects/asdc-attendance/databases/(default)/documents/settings/qr_access`;
          await fetch(firestoreUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${idToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                qrAccessEnabled: { booleanValue: targetEnabled },
                status: { stringValue: targetEnabled ? 'ENABLED' : 'DISABLED' },
                updatedAt: { stringValue: result.updatedAt },
                updatedBy: { stringValue: adminEmail },
              },
            }),
          });
        } catch (restErr) {
          console.warn('[Toggle QR API] Firestore REST sync notice:', restErr);
        }
      }
    }

    return NextResponse.json({
      success: true,
      qrAccessEnabled: result.qrAccessEnabled,
      status: result.status,
      qrAccessStatus: result.status,
      updatedAt: result.updatedAt,
      message: `Classroom QR access has been ${result.status}.`,
    });
  } catch (error) {
    console.error('Error toggling QR active state:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update QR state.' },
      { status: 500 }
    );
  }
}
