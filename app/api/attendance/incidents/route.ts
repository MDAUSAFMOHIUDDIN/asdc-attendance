import { NextRequest, NextResponse } from 'next/server';
import { getLocationIncidents, markIncidentReviewed, logLocationIncident } from '@/lib/geofence-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator can view location security incidents.' },
        { status: 403 }
      );
    }

    const incidents = getLocationIncidents(adminEmail);
    return NextResponse.json({
      success: true,
      incidents,
      totalCount: incidents.length,
      unreviewedCount: incidents.filter((i) => i.status === 'New').length,
    });
  } catch (error) {
    console.error('Error fetching location incidents:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch incidents' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, incidentId, action } = body;

    // Admin review action
    if (action === 'review' || incidentId) {
      if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
        return NextResponse.json(
          { error: 'Unauthorized: Only administrator can review incidents.' },
          { status: 403 }
        );
      }

      const updatedIncidents = markIncidentReviewed(adminEmail, incidentId);
      return NextResponse.json({
        success: true,
        message: 'Incident marked as reviewed.',
        incidents: updatedIncidents,
      });
    }

    // Client-side incident reporting (e.g. permission denied or location failed from scanner)
    const {
      studentId,
      studentName,
      studentEmail,
      incidentType,
      latitude,
      longitude,
      gpsAccuracy,
      distanceMeters,
      details,
    } = body;

    if (!studentId || !incidentType) {
      return NextResponse.json({ error: 'Missing incident report fields' }, { status: 400 });
    }

    const incident = logLocationIncident({
      studentId,
      studentName: studentName || 'Unknown Student',
      studentEmail: studentEmail || '',
      incidentType,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      gpsAccuracy: gpsAccuracy ?? null,
      distanceMeters: distanceMeters ?? null,
      details: details || '',
    });

    return NextResponse.json({ success: true, incident });
  } catch (error) {
    console.error('Error handling incident:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to process incident' },
      { status: 500 }
    );
  }
}
