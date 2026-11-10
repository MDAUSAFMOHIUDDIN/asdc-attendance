import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { getMasterWorkbookFilePath, ensureMasterWorkbook } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail');

    if (!adminEmail || !isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only administrator (mdausafmohiuddin@gmail.com) can download the master Excel workbook.' },
        { status: 403 }
      );
    }

    await ensureMasterWorkbook();
    const filePath = getMasterWorkbookFilePath();

    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        { error: 'Master workbook file B-19-AI Builder (1) (3).xlsx not found on server.' },
        { status: 404 }
      );
    }

    const fileBuffer = fs.readFileSync(filePath);
    if (!fileBuffer || fileBuffer.length === 0) {
      return NextResponse.json(
        { error: 'Master workbook file is empty or corrupted.' },
        { status: 500 }
      );
    }

    const filename = 'B-19-AI Builder (1) (3).xlsx';
    const encodedFilename = encodeURIComponent(filename);

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`,
        'Content-Length': fileBuffer.length.toString(),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('[Download API] Error serving master excel:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve canonical master workbook.' },
      { status: 500 }
    );
  }
}
