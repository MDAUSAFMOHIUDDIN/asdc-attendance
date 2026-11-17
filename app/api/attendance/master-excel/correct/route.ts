import { NextRequest, NextResponse } from 'next/server';
import { correctAttendanceEntryInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin, INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, setDoc, getDocs, collection, query, where, getDoc } from 'firebase/firestore';
import { AuditLog, AttendanceRecord, StudentProfile } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const body = await request.json();
    const { adminEmail, row, studentId, studentName, date, newStatus, reason } = body;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only authorized administrator may correct attendance.' },
        { status: 403 }
      );
    }

    if (!date || newStatus === undefined || !reason) {
      return NextResponse.json(
        { error: 'Missing required fields: date, newStatus, reason.' },
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
    const excelResult = await correctAttendanceEntryInMaster({
      row: row ? Number(row) : undefined,
      studentId,
      studentName,
      dateStr: date,
      newStatus,
      reason: reason.trim(),
      adminEmail,
      idToken,
    });

    const studentDisplayName = excelResult.studentName || studentName || 'Student';
    const nowIso = new Date().toISOString();

    // 2. Locate Student in Firestore to keep Authoritative Database 100% Synchronized
    let targetStudent: StudentProfile | null = null;
    try {
      const snap = await getDocs(collection(db, 'students'));
      snap.forEach((d) => {
        const p = d.data() as StudentProfile;
        if (studentId && p.studentId === studentId) {
          targetStudent = p;
        } else if (!targetStudent && studentDisplayName) {
          const normA = p.fullName.toLowerCase().replace(/[\.\,\_\-\s]+/g, ' ').trim();
          const normB = studentDisplayName.toLowerCase().replace(/[\.\,\_\-\s]+/g, ' ').trim();
          if (normA === normB || normA.includes(normB) || normB.includes(normA)) {
            targetStudent = p;
          }
        }
      });
    } catch (err) {
      console.warn('[Correct API] Firestore student lookup notice:', err);
    }

    // 3. Update Authoritative Attendance Record in Firestore
    if (targetStudent) {
      const studentObj = targetStudent as StudentProfile;
      const attendanceDocId = `${studentObj.uid}_${date}`;
      const normalizedStatus =
        newStatus === 'P'
          ? 'PRESENT'
          : newStatus === 'A'
          ? 'ABSENT'
          : newStatus === 'L'
          ? 'EXCUSED'
          : 'ABSENT';

      const updatedRecord: AttendanceRecord = {
        id: attendanceDocId,
        studentUid: studentObj.uid,
        studentId: studentObj.studentId,
        studentName: studentObj.fullName,
        studentEmail: studentObj.email,
        classDate: date,
        batchId: studentObj.batchId || INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
        status: normalizedStatus,
        source: 'ADMIN_MANUAL',
        verifiedAt: nowIso,
        submittedAt: nowIso,
        timestamp: nowIso,
        eventId: `att_corr_${Date.now()}_${studentObj.studentId}`,
        dbCommitStatus: 'COMMITTED',
        excelSyncStatus: 'SYNCED',
        finalizationStatus: 'FINALIZED',
        correctionReason: reason.trim(),
      };

      try {
        await setDoc(doc(db, 'attendance', attendanceDocId), updatedRecord);
      } catch (sdkErr) {
        console.warn('[Correct API] SDK record update note:', sdkErr);
      }

      if (idToken) {
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${attendanceDocId}`;
          await fetch(restUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: {
                id: { stringValue: updatedRecord.id },
                studentUid: { stringValue: updatedRecord.studentUid },
                studentId: { stringValue: updatedRecord.studentId },
                studentName: { stringValue: updatedRecord.studentName },
                studentEmail: { stringValue: updatedRecord.studentEmail },
                classDate: { stringValue: updatedRecord.classDate },
                batchId: { stringValue: updatedRecord.batchId },
                status: { stringValue: updatedRecord.status },
                source: { stringValue: updatedRecord.source },
                verifiedAt: { stringValue: updatedRecord.verifiedAt },
                submittedAt: { stringValue: updatedRecord.submittedAt || nowIso },
                timestamp: { stringValue: nowIso },
                eventId: { stringValue: updatedRecord.eventId || '' },
                dbCommitStatus: { stringValue: 'COMMITTED' },
                excelSyncStatus: { stringValue: 'SYNCED' },
                finalizationStatus: { stringValue: 'FINALIZED' },
                correctionReason: { stringValue: reason.trim() },
              },
            }),
          });
        } catch {}
      }
    }

    // 4. Record Audit Log in Firestore
    try {
      const logId = `corr_${Date.now()}_r${excelResult.row}`;
      const auditLog: AuditLog = {
        id: logId,
        adminEmail,
        action: 'MASTER_EXCEL_CORRECTION',
        targetStudentId: targetStudent ? (targetStudent as StudentProfile).studentId : `ROW_${excelResult.row}`,
        targetStudentName: studentDisplayName,
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
      message: `Successfully updated attendance for ${studentDisplayName} on ${date} to '${newStatus || 'Cleared'}'.`,
      result: excelResult,
    });
  } catch (error) {
    console.error('Correction error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to correct attendance entry.' },
      { status: 500 }
    );
  }
}
