import { NextRequest, NextResponse } from 'next/server';
import { getMasterAttendanceForDate } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');
    const date = searchParams.get('date');

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json({ error: 'Unauthorized: Admin access required.' }, { status: 403 });
    }

    if (!date) {
      return NextResponse.json({ error: 'Missing date parameter (YYYY-MM-DD).' }, { status: 400 });
    }

    const data = await getMasterAttendanceForDate(date);
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching master excel date data:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve date attendance data.' },
      { status: 500 }
    );
  }
}
