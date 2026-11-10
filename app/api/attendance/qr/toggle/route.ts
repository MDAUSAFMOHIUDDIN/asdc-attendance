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

    let targetStatus: QRAccessStatus = 'ENABLED';
    if (status) {
      targetStatus = status === 'ENABLED' ? 'ENABLED' : 'DISABLED';
    } else if (activate !== undefined) {
      targetStatus = activate ? 'ENABLED' : 'DISABLED';
    }

    const result = await setQRAccessStatus(adminEmail, targetStatus);

    return NextResponse.json({
      success: true,
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
