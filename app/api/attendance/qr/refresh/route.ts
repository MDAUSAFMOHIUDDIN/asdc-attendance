import { NextRequest, NextResponse } from 'next/server';
import { refreshQRChallenge } from '@/lib/qr-challenge-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail } = body;

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator (mdausafmohiuddin@gmail.com) can manage classroom QR.' },
        { status: 403 }
      );
    }

    const refreshResult = await refreshQRChallenge(adminEmail);

    return NextResponse.json({
      success: true,
      ...refreshResult,
    });
  } catch (error) {
    console.error('Error fetching QR:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve permanent QR.' },
      { status: 500 }
    );
  }
}
