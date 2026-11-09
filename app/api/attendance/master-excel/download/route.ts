import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getMasterWorkbookFilePath, ensureMasterWorkbook } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json({ error: 'Unauthorized: Admin access required.' }, { status: 403 });
    }

    await ensureMasterWorkbook();
    const filePath = getMasterWorkbookFilePath();

    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: 'Master workbook not found.' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);
    const filename = 'B-19-AI Builder (1) (3).xlsx';

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (error) {
    console.error('Error downloading master excel:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to download master workbook.' },
      { status: 500 }
    );
  }
}
