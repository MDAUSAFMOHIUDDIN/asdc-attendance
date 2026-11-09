import { NextRequest, NextResponse } from 'next/server';
import { getGeofenceConfig, updateGeofenceConfig, OFFICIAL_ASDC_LOCATION } from '@/lib/geofence-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET() {
  try {
    const config = getGeofenceConfig();
    return NextResponse.json({
      success: true,
      config,
      officialLocation: OFFICIAL_ASDC_LOCATION,
    });
  } catch (error) {
    console.error('Error fetching geofence config:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch geofence config' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, radiusMeters, maxAccuracyMeters } = body;

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator can modify geofence configuration.' },
        { status: 403 }
      );
    }

    const updated = updateGeofenceConfig(adminEmail, {
      radiusMeters: typeof radiusMeters === 'number' ? radiusMeters : undefined,
      maxAccuracyMeters: typeof maxAccuracyMeters === 'number' ? maxAccuracyMeters : undefined,
    });

    return NextResponse.json({
      success: true,
      message: 'Geofence configuration successfully updated.',
      config: updated,
    });
  } catch (error) {
    console.error('Error updating geofence config:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update geofence config' },
      { status: 500 }
    );
  }
}
