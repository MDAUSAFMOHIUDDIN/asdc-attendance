import { NextRequest, NextResponse } from 'next/server';
import { correctAttendanceEntryInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { AuditLog } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adminEmail, row, date, newStatus, reason } = body;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json({ error: 'Unauthorized: Only authorized admin may correct attendance.' }, { status: 403 });
    }

    if (!row || !date || newStatus === undefined || !reason) {
      return NextResponse.json(
        { error: 'Missing required fields: row, date, newStatus, reason.' },
        { status: 400 }
      );
    }

    if (reason.trim().length < 5) {
      return NextResponse.json(
        { error: 'A detailed audit reason (at least 5 characters) is mandatory.' },
        { status: 400 }
      );
    }

    // 1. Correct in Master Excel Workbook
    const result = await correctAttendanceEntryInMaster({
      row: Number(row),
      dateStr: date,
      newStatus,
      reason,
      adminEmail,
    });

    // 2. Record Audit Log in Firestore
    try {
      const nowIso = new Date().toISOString();
      const logId = `corr_${Date.now()}_r${row}`;
      const auditLog: AuditLog = {
        id: logId,
        adminEmail,
        action: 'MASTER_EXCEL_CORRECTION',
        targetStudentId: `ROW_${row}`,
        targetStudentName: result.studentName,
        targetDate: date,
        newStatus: newStatus || 'EMPTY',
        reason: reason.trim(),
        timestamp: nowIso,
      };
      await setDoc(doc(db, 'audit_logs', logId), auditLog);
    } catch (auditErr) {
      console.warn('Could not write audit log to firestore:', auditErr);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully updated attendance for ${result.studentName} on ${date} to '${newStatus || 'Cleared'}'.`,
      result,
    });
  } catch (error) {
    console.error('Correction error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to correct attendance entry.' },
      { status: 500 }
    );
  }
}
