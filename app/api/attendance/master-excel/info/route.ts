import { NextRequest, NextResponse } from 'next/server';
import { getMasterWorkbookInfo } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json({ error: 'Unauthorized: Admin access required.' }, { status: 403 });
    }

    const info = await getMasterWorkbookInfo();
    return NextResponse.json(info);
  } catch (error) {
    console.error('Error fetching master excel info:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve master workbook info.' },
      { status: 500 }
    );
  }
}
