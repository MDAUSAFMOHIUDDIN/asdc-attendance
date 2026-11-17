import { NextRequest, NextResponse } from 'next/server';
import { getMasterWorkbookBufferForDownload, reconcileAllDatesInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { AttendanceRecord, FinalizedDateRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

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

    // 1. Reconcile with latest authoritative database records before download
    try {
      const [attSnap, finSnap] = await Promise.all([
        getDocs(collection(db, 'attendance')),
        getDocs(collection(db, 'finalized_dates')),
      ]);

      const allRecords: AttendanceRecord[] = [];
      attSnap.forEach((d) => allRecords.push(d.data() as AttendanceRecord));

      const finalizedDates: string[] = [];
      finSnap.forEach((d) => {
        const f = d.data() as FinalizedDateRecord;
        if (f && f.date) finalizedDates.push(f.date);
      });

      if (allRecords.length > 0) {
        await reconcileAllDatesInMaster({
          allAttendanceRecords: allRecords,
          finalizedDates,
          adminEmail,
        });
      }
    } catch (reconcileErr) {
      console.warn('[Download API] Pre-download reconciliation notice:', reconcileErr);
    }

    // 2. Retrieve verified canonical workbook buffer
    const { buffer: fileBuffer, filename } = await getMasterWorkbookBufferForDownload();

    if (!fileBuffer || fileBuffer.length === 0) {
      return NextResponse.json(
        { error: 'Master workbook file is empty or corrupted.' },
        { status: 500 }
      );
    }

    // Verify OpenXML ZIP signature (PK\x03\x04)
    if (fileBuffer.length < 4 || fileBuffer.readUInt32LE(0) !== 0x04034b50) {
      return NextResponse.json(
        { error: 'Master workbook validation failed: invalid XLSX header.' },
        { status: 500 }
      );
    }

    const officialFilename = 'B-19-AI Builder (1) (3).xlsx';
    const encodedFilename = encodeURIComponent(officialFilename);

    return new NextResponse(new Uint8Array(fileBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${officialFilename}"; filename*=UTF-8''${encodedFilename}`,
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
