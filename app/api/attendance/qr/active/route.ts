import { NextRequest, NextResponse } from 'next/server';
import { getActiveQRChallenge } from '@/lib/qr-challenge-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');
    const isAdmin = isAuthorizedAdmin(adminEmail);

    const activeInfo = await getActiveQRChallenge();

    if (isAdmin) {
      return NextResponse.json({
        success: true,
        challenge: activeInfo.challenge,
        qrDataUrl: activeInfo.qrDataUrl,
        qrAccessStatus: activeInfo.qrAccessStatus,
        status: activeInfo.qrAccessStatus,
        isPermanent: true,
        totalRefreshes: 0,
        history: [],
      });
    }

    // Public / student safe view
    return NextResponse.json({
      success: true,
      challengeId: activeInfo.challenge.challengeId,
      status: activeInfo.qrAccessStatus,
      qrAccessStatus: activeInfo.qrAccessStatus,
      qrPayload: activeInfo.challenge.qrPayload,
      qrDataUrl: activeInfo.qrDataUrl,
      isPermanent: true,
    });
  } catch (error) {
    console.error('Error fetching active QR challenge:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch active QR' },
      { status: 500 }
    );
  }
}
