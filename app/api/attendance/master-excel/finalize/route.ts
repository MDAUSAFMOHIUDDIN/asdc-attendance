import { NextRequest, NextResponse } from 'next/server';
import { finalizeDailyAttendanceInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, setDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { AuditLog, AttendanceRecord } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const body = await request.json();
    const { adminEmail, date, attendanceRecords } = body;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only authorized admin may finalize attendance.' },
        { status: 403 }
      );
    }

    if (!date) {
      return NextResponse.json({ error: 'Missing date parameter.' }, { status: 400 });
    }

    // Determine confirmed attendance records
    let recordsToUse: AttendanceRecord[] = Array.isArray(attendanceRecords) ? attendanceRecords : [];
    if (recordsToUse.length === 0) {
      try {
        const q = query(
          collection(db, 'attendance'),
          where('classDate', '==', date)
        );
        const snap = await getDocs(q);
        const fetched: AttendanceRecord[] = [];
        snap.forEach((d) => {
          fetched.push(d.data() as AttendanceRecord);
        });
        if (fetched.length > 0) {
          recordsToUse = fetched;
        }
      } catch (qErr) {
        console.warn('[Finalize API] Firestore query notice:', qErr);
      }
    }

    // 1. Finalize in Master Excel Workbook
    const result = await finalizeDailyAttendanceInMaster(date, adminEmail, recordsToUse, idToken);

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

      // Client SDK write
      await setDoc(doc(db, 'audit_logs', logId), auditLog);

      // Also persist via REST if idToken available
      if (idToken) {
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/audit_logs/${logId}`;
          await fetch(restUrl, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${idToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                id: { stringValue: auditLog.id },
                adminEmail: { stringValue: auditLog.adminEmail },
                action: { stringValue: auditLog.action },
                targetStudentId: { stringValue: auditLog.targetStudentId },
                targetStudentName: { stringValue: auditLog.targetStudentName },
                targetDate: { stringValue: auditLog.targetDate },
                newStatus: { stringValue: auditLog.newStatus },
                reason: { stringValue: auditLog.reason },
                timestamp: { stringValue: auditLog.timestamp },
              },
            }),
          });
        } catch (restErr) {
          console.warn('[Finalize API] Audit log REST notice:', restErr);
        }
      }
    } catch (auditErr) {
      console.warn('Could not write audit log to firestore:', auditErr);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully finalized attendance for ${date}. Confirmed: ${result.presentCount} Present, ${result.absentCount} Absent in Master Excel register.`,
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
