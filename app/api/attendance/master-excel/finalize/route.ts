import { NextRequest, NextResponse } from 'next/server';
import { finalizeDailyAttendanceInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { AuditLog } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, date } = body;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json({ error: 'Unauthorized: Only authorized admin may finalize attendance.' }, { status: 403 });
    }

    if (!date) {
      return NextResponse.json({ error: 'Missing date parameter.' }, { status: 400 });
    }

    // 1. Finalize in Master Excel Workbook
    const result = await finalizeDailyAttendanceInMaster(date, adminEmail);

    // 2. Record Audit Log in Firestore
    try {
      const nowIso = new Date().toISOString();
      const logId = `finalize_${Date.now()}_${date}`;
      const auditLog: AuditLog = {
        id: logId,
        adminEmail,
        action: 'FINALIZE_DAILY_ATTENDANCE',
        targetStudentId: 'BATCH_19_ALL',
        targetStudentName: 'Batch 19 Students',
        targetDate: date,
        newStatus: 'FINALIZED',
        reason: `Finalized daily attendance for ${date}. Marked ${result.finalizedCount} unrecorded students as Absent (A). Total Present: ${result.presentCount}, Total Absent: ${result.absentCount}.`,
        timestamp: nowIso,
      };
      await setDoc(doc(db, 'audit_logs', logId), auditLog);
    } catch (auditErr) {
      console.warn('Could not write audit log to firestore:', auditErr);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully finalized attendance for ${date}. ${result.finalizedCount} students marked Absent in Master Excel register.`,
      result,
    });
  } catch (error) {
    console.error('Finalization error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to finalize attendance.' },
      { status: 500 }
    );
  }
}
