import { NextRequest, NextResponse } from 'next/server';
import { refreshQRChallenge } from '@/lib/qr-challenge-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail } = body;

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator (mdausafmohiuddin@gmail.com) can refresh classroom QR.' },
        { status: 403 }
      );
    }

    const refreshResult = await refreshQRChallenge(adminEmail);

    return NextResponse.json({
      success: true,
      message: 'New classroom QR challenge generated and activated. Previous QR code invalidated immediately.',
      ...refreshResult,
    });
  } catch (error) {
    console.error('Error refreshing QR challenge:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to refresh QR challenge.' },
      { status: 500 }
    );
  }
}
