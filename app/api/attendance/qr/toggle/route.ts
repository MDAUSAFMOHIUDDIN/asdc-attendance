import { NextRequest, NextResponse } from 'next/server';
import { toggleQRChallengeActive } from '@/lib/qr-challenge-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, activate } = body;

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator can toggle QR code activation.' },
        { status: 403 }
      );
    }

    const result = await toggleQRChallengeActive(adminEmail, Boolean(activate));

    return NextResponse.json({
      success: true,
      message: `Classroom QR has been ${activate ? 'activated' : 'deactivated'}.`,
      ...result,
    });
  } catch (error) {
    console.error('Error toggling QR active state:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update QR state.' },
      { status: 500 }
    );
  }
}
