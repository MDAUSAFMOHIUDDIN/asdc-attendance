import { NextRequest, NextResponse } from 'next/server';
import { finalizeDailyAttendanceInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin, INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, setDoc, getDocs, collection, query, where } from 'firebase/firestore';
import { AuditLog, AttendanceRecord, StudentProfile, FinalizedDateRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const body = await request.json();
    const { adminEmail, date, attendanceRecords } = body;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only authorized admin (mdausafmohiuddin@gmail.com) may finalize attendance.' },
        { status: 403 }
      );
    }

    if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return NextResponse.json(
        { error: 'Invalid or missing date parameter. Expected format: YYYY-MM-DD.' },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();

    // 1. Fetch all registered students
    const allStudents: StudentProfile[] = [];
    if (idToken) {
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
        console.warn('[Finalize API] Students REST fetch notice:', err);
      }
    }

    if (allStudents.length === 0) {
      try {
        const snap = await getDocs(collection(db, 'students'));
        snap.forEach((d) => {
          allStudents.push(d.data() as StudentProfile);
        });
      } catch (sdkErr) {
        console.warn('[Finalize API] Students SDK fetch notice:', sdkErr);
      }
    }

    // 2. Fetch all confirmed attendance records for date
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
      console.warn('[Finalize API] Existing attendance query notice:', qErr);
    }

    // 3. Process every registered student and commit authoritative status to Firestore
    const allRecordsForDate: AttendanceRecord[] = [];
    let presentCount = 0;
    let absentCount = 0;
    let excusedCount = 0;
    let newlyMarkedAbsentCount = 0;

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

        // Update in Firestore
        try {
          await setDoc(doc(db, 'attendance', docId), updated, { merge: true });
        } catch {}

        if (idToken) {
          try {
            const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${docId}`;
            await fetch(restUrl, {
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
          } catch {}
        }
      } else {
        // No attendance recorded: mark ABSENT only on administrator finalization confirmation
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

        // Commit to Firestore attendance collection
        try {
          await setDoc(doc(db, 'attendance', docId), absentRecord);
        } catch (setErr) {
          console.warn(`[Finalize API] Could not write absent record via SDK for ${student.studentId}:`, setErr);
        }

        if (idToken) {
          try {
            const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${docId}`;
            await fetch(restUrl, {
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
          } catch (restErr) {
            console.warn(`[Finalize API] Could not write absent record via REST for ${student.studentId}:`, restErr);
          }
        }
      }
    }

    // 4. Record Finalized Date in Firestore finalized_dates collection
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
      await setDoc(doc(db, 'finalized_dates', date), finalizationDoc);
    } catch (fErr) {
      console.warn('[Finalize API] finalized_dates write note:', fErr);
    }

    if (idToken) {
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
      } catch (fRestErr) {
        console.warn('[Finalize API] finalized_dates REST note:', fRestErr);
      }
    }

    // 5. Finalize and synchronize in Canonical Master Excel Workbook
    const excelResult = await finalizeDailyAttendanceInMaster(date, adminEmail, allRecordsForDate, idToken);

    // 6. Record Audit Log in Firestore
    try {
      const logId = `finalize_${Date.now()}_${date}`;
      const auditLog: AuditLog = {
        id: logId,
        adminEmail,
        action: 'FINALIZE_DAILY_ATTENDANCE',
        targetStudentId: 'BATCH_19_ALL',
        targetStudentName: 'Batch 19 Students',
        targetDate: date,
        newStatus: 'FINALIZED',
        reason: `Finalized daily attendance for ${date}. Confirmed ${presentCount} Present, ${absentCount} Absent (${newlyMarkedAbsentCount} newly marked), ${excusedCount} Excused across all ${allStudents.length} registered students in authoritative DB & Master Excel.`,
        timestamp: nowIso,
      };

      await setDoc(doc(db, 'audit_logs', logId), auditLog);

      if (idToken) {
        try {
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
        } catch {}
      }
    } catch (auditErr) {
      console.warn('[Finalize API] Audit log write note:', auditErr);
    }

    return NextResponse.json({
      success: true,
      message: `Successfully finalized attendance for ${date}. Authoritative records updated: ${presentCount} Present, ${absentCount} Absent in database and Master Excel workbook.`,
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
