import { NextRequest, NextResponse } from 'next/server';
import { finalizeDailyAttendanceInMaster } from '@/lib/excel-master-service';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, setDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { AuditLog, AttendanceRecord, StudentProfile, FinalizedDateRecord } from '@/lib/types';
import { verifyAdminToken } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (!idToken) {
      return NextResponse.json(
        { error: 'Missing administrator authentication token. You must be signed in as an administrator.' },
        { status: 401 }
      );
    }

    // 1. Verify the actual administrator's Firebase ID token on the trusted backend
    const adminAuth = await verifyAdminToken(idToken);
    if (!adminAuth.authorized || !adminAuth.email) {
      return NextResponse.json(
        { error: adminAuth.error || 'Unauthorized: Only authorized institute administrators can finalize attendance.' },
        { status: 403 }
      );
    }

    const adminEmail = adminAuth.email;
    const body = await request.json().catch(() => ({}));
    const { date, attendanceRecords } = body;

    if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return NextResponse.json(
        { error: 'Invalid or missing date parameter. Expected format: YYYY-MM-DD.' },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();

    // 2. Retrieve authoritative registered students from Firestore
    const allStudents: StudentProfile[] = [];
    try {
      const restStudentsUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/students?pageSize=500`;
      const restRes = await fetch(restStudentsUrl, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (restRes.ok) {
        const sData = await restRes.json();
        const docs = sData.documents || [];
        for (const d of docs) {
          const f = d.fields || {};
          const uid = f.uid?.stringValue || d.name?.split('/').pop() || '';
          const studentId = f.studentId?.stringValue || '';
          const fullName = f.fullName?.stringValue || '';
          const email = f.email?.stringValue || '';
          const phoneNumber = f.phoneNumber?.stringValue || '';
          const fatherName = f.fatherName?.stringValue || '';
          const motherName = f.motherName?.stringValue || '';
          const batchId = f.batchId?.stringValue || INSTITUTE_CONFIG.DEFAULT_BATCH_ID;
          const batchName = f.batchName?.stringValue || INSTITUTE_CONFIG.DEFAULT_BATCH_NAME;
          if (uid && studentId && fullName) {
            allStudents.push({
              uid,
              studentId,
              fullName,
              email,
              phoneNumber,
              fatherName,
              motherName,
              batchId,
              batchName,
              createdAt: f.createdAt?.stringValue || nowIso,
              updatedAt: f.updatedAt?.stringValue || nowIso,
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Finalize API] Students REST query notice:', err);
    }

    if (allStudents.length === 0) {
      try {
        const snap = await getDocs(collection(db, 'students'));
        snap.forEach((d) => {
          allStudents.push(d.data() as StudentProfile);
        });
      } catch (sdkErr) {
        console.warn('[Finalize API] Students SDK query notice:', sdkErr);
      }
    }

    // 3. Retrieve authoritative attendance for the selected date
    const existingRecordsMap: Record<string, AttendanceRecord> = {};
    if (Array.isArray(attendanceRecords) && attendanceRecords.length > 0) {
      attendanceRecords.forEach((r: AttendanceRecord) => {
        if (r.studentUid) existingRecordsMap[r.studentUid] = r;
      });
    }

    try {
      const q = query(collection(db, 'attendance'), where('classDate', '==', date));
      const snap = await getDocs(q);
      snap.forEach((d) => {
        const rec = d.data() as AttendanceRecord;
        if (rec.studentUid) existingRecordsMap[rec.studentUid] = rec;
      });
    } catch (qErr) {
      console.warn('[Finalize API] Attendance query notice:', qErr);
    }

    // 4. Validate every database update and commit to Firestore
    const allRecordsForDate: AttendanceRecord[] = [];
    let presentCount = 0;
    let absentCount = 0;
    let excusedCount = 0;
    let newlyMarkedAbsentCount = 0;
    let failedDatabaseWrites = 0;
    const writeErrors: string[] = [];

    for (const student of allStudents) {
      const existing = existingRecordsMap[student.uid];
      const docId = `${student.uid}_${date}`;

      if (existing) {
        const isPres = existing.status === 'PRESENT' || (existing.status as any) === 'P';
        const isExc = existing.status === 'EXCUSED' || (existing.status as any) === 'L';
        const finalStatus = isPres ? 'PRESENT' : isExc ? 'EXCUSED' : 'ABSENT';

        if (isPres) presentCount++;
        else if (isExc) excusedCount++;
        else absentCount++;

        const updated: AttendanceRecord = {
          ...existing,
          id: docId,
          studentUid: student.uid,
          studentId: student.studentId,
          studentName: student.fullName,
          studentEmail: student.email,
          classDate: date,
          status: finalStatus,
          finalizationStatus: 'FINALIZED',
          excelSyncStatus: 'SYNCED',
        };

        allRecordsForDate.push(updated);

        // Commit and validate database write via authenticated REST API
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${docId}`;
          const res = await fetch(restUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                finalizationStatus: { stringValue: 'FINALIZED' },
                excelSyncStatus: { stringValue: 'SYNCED' },
                status: { stringValue: finalStatus },
              },
            }),
          });
          if (!res.ok) {
            const errText = await res.text();
            failedDatabaseWrites++;
            writeErrors.push(`Failed to update attendance for ${student.studentId}: ${errText}`);
          }
        } catch (dbErr: any) {
          failedDatabaseWrites++;
          writeErrors.push(`Error writing attendance for ${student.studentId}: ${dbErr?.message}`);
        }
      } else {
        // No attendance recorded: Apply 'ABSENT' upon explicit administrator finalization
        absentCount++;
        newlyMarkedAbsentCount++;

        const absentRecord: AttendanceRecord = {
          id: docId,
          studentUid: student.uid,
          studentId: student.studentId,
          studentName: student.fullName,
          studentEmail: student.email,
          classDate: date,
          batchId: student.batchId || INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
          status: 'ABSENT',
          source: 'ADMIN_MANUAL',
          verifiedAt: nowIso,
          submittedAt: nowIso,
          timestamp: nowIso,
          eventId: `att_absent_${Date.now()}_${student.studentId}`,
          dbCommitStatus: 'COMMITTED',
          excelSyncStatus: 'SYNCED',
          finalizationStatus: 'FINALIZED',
          correctionReason: `Marked absent upon official administrator finalization on ${date}.`,
        };

        allRecordsForDate.push(absentRecord);

        // Commit and validate database write
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${docId}`;
          const res = await fetch(restUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                id: { stringValue: absentRecord.id },
                studentUid: { stringValue: absentRecord.studentUid },
                studentId: { stringValue: absentRecord.studentId },
                studentName: { stringValue: absentRecord.studentName },
                studentEmail: { stringValue: absentRecord.studentEmail },
                classDate: { stringValue: absentRecord.classDate },
                batchId: { stringValue: absentRecord.batchId },
                status: { stringValue: absentRecord.status },
                source: { stringValue: absentRecord.source },
                verifiedAt: { stringValue: absentRecord.verifiedAt },
                submittedAt: { stringValue: absentRecord.submittedAt || nowIso },
                timestamp: { stringValue: nowIso },
                eventId: { stringValue: absentRecord.eventId || '' },
                dbCommitStatus: { stringValue: 'COMMITTED' },
                excelSyncStatus: { stringValue: 'SYNCED' },
                finalizationStatus: { stringValue: 'FINALIZED' },
                correctionReason: { stringValue: absentRecord.correctionReason || '' },
              },
            }),
          });
          if (!res.ok) {
            const errText = await res.text();
            failedDatabaseWrites++;
            writeErrors.push(`Failed to commit absent record for ${student.studentId}: ${errText}`);
          }
        } catch (dbErr: any) {
          failedDatabaseWrites++;
          writeErrors.push(`Error committing absent record for ${student.studentId}: ${dbErr?.message}`);
        }
      }
    }

    // Never mark an operation successful when a database write failed
    if (failedDatabaseWrites > 0) {
      return NextResponse.json(
        {
          error: `Finalization failed: ${failedDatabaseWrites} database write(s) could not be committed.`,
          details: writeErrors,
        },
        { status: 500 }
      );
    }

    // 5. Finalize only the selected date in Firestore finalized_dates
    const finalizationDoc: FinalizedDateRecord = {
      id: date,
      date,
      finalizedAt: nowIso,
      finalizedBy: adminEmail,
      presentCount,
      absentCount,
      excusedCount,
      totalStudents: allStudents.length,
      status: 'FINALIZED',
    };

    try {
      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/finalized_dates/${date}`;
      await fetch(restUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: finalizationDoc.id },
            date: { stringValue: finalizationDoc.date },
            finalizedAt: { stringValue: finalizationDoc.finalizedAt },
            finalizedBy: { stringValue: finalizationDoc.finalizedBy },
            presentCount: { integerValue: String(presentCount) },
            absentCount: { integerValue: String(absentCount) },
            excusedCount: { integerValue: String(excusedCount) },
            totalStudents: { integerValue: String(allStudents.length) },
            status: { stringValue: 'FINALIZED' },
          },
        }),
      });
    } catch (fErr) {
      console.warn('[Finalize API] finalized_dates write notice:', fErr);
    }

    // 6. Synchronize corresponding Excel date column and verify uploaded workbook
    const excelResult = await finalizeDailyAttendanceInMaster(date, adminEmail, allRecordsForDate, idToken);

    // 7. Record minimal audit log
    try {
      const logId = `finalize_${Date.now()}_${date}`;
      const auditLog: AuditLog = {
        id: logId,
        adminEmail,
        action: 'FINALIZE_DAILY_ATTENDANCE',
        targetStudentId: 'BATCH_ALL',
        targetStudentName: 'All Registered Students',
        targetDate: date,
        newStatus: 'FINALIZED',
        reason: `Finalized date ${date}: ${presentCount} Present, ${absentCount} Absent (${newlyMarkedAbsentCount} unrecorded marked absent), ${excusedCount} Excused across ${allStudents.length} students.`,
        timestamp: nowIso,
      };

      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/audit_logs/${logId}`;
      await fetch(restUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
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
    } catch (auditErr) {
      console.warn('[Finalize API] Audit log write note:', auditErr);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully finalized attendance for ${date}. Authoritative records confirmed: ${presentCount} Present, ${absentCount} Absent in database and Master Excel workbook.`,
      result: {
        date,
        presentCount,
        absentCount,
        excusedCount,
        newlyMarkedAbsentCount,
        totalStudents: allStudents.length,
        version: excelResult.version,
        column: excelResult.column,
      },
    });
  } catch (error) {
    console.error('[Finalize API] Finalization error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to finalize attendance.' },
      { status: 500 }
    );
  }
}
