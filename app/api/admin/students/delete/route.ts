import { NextRequest, NextResponse } from 'next/server';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, deleteDoc, getDocs, collection, query, where, getDoc } from 'firebase/firestore';
import { verifyAdminToken, deleteStudentAuthAccount } from '@/lib/firebase-admin';
import { removeStudentFromMasterWorkbook } from '@/lib/excel-master-service';
import { AuditLog } from '@/lib/types';

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

    // 1. Verify that caller is one of the authorized administrators
    const adminAuth = await verifyAdminToken(idToken);
    if (!adminAuth.authorized || !adminAuth.email) {
      return NextResponse.json(
        { error: adminAuth.error || 'Unauthorized: Only authorized institute administrators can permanently delete students.' },
        { status: 403 }
      );
    }

    const adminEmail = adminAuth.email;
    const body = await request.json().catch(() => ({}));
    const { studentUid, studentId, confirmStudentId } = body;

    if (!studentUid || !studentId) {
      return NextResponse.json(
        { error: 'Missing required student identification parameters (studentUid and studentId).' },
        { status: 400 }
      );
    }

    // 2. Strict Confirmation Check: Require administrator to type the exact student ID
    if (!confirmStudentId || confirmStudentId.trim().toUpperCase() !== studentId.trim().toUpperCase()) {
      return NextResponse.json(
        {
          error: `Safety confirmation failed: Entered Student ID '${confirmStudentId || ''}' does not match the target Student ID '${studentId}'. Deletion aborted.`,
        },
        { status: 400 }
      );
    }

    // Safety guard: Never allow deleting an administrator account
    if (studentUid === adminAuth.uid) {
      return NextResponse.json(
        { error: 'Security rejection: An administrator account cannot be deleted via student removal.' },
        { status: 400 }
      );
    }

    // 3. Create unique opaque deletion job identifier
    const opaqueJobId = `del_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const nowIso = new Date().toISOString();

    const cleanupErrors: string[] = [];
    let attendanceDeletedCount = 0;
    let notifsDeletedCount = 0;

    // 4. Delete associated personal attendance records from Firestore
    try {
      const q = query(collection(db, 'attendance'), where('studentUid', '==', studentUid));
      const attSnap = await getDocs(q);
      for (const d of attSnap.docs) {
        try {
          await deleteDoc(d.ref);
          attendanceDeletedCount++;
        } catch {
          // Try REST
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${d.id}`;
          const res = await fetch(restUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${idToken}` },
          });
          if (res.ok) attendanceDeletedCount++;
        }
      }
    } catch (attErr: any) {
      cleanupErrors.push(`Attendance cleanup notice: ${attErr?.message}`);
    }

    // 5. Delete student-specific notifications from Firestore
    try {
      const nq = query(collection(db, 'notifications'), where('recipientUid', '==', studentUid));
      const notifSnap = await getDocs(nq);
      for (const d of notifSnap.docs) {
        try {
          await deleteDoc(d.ref);
          notifsDeletedCount++;
        } catch {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/notifications/${d.id}`;
          await fetch(restUrl, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${idToken}` },
          });
          notifsDeletedCount++;
        }
      }
    } catch (notifErr: any) {
      cleanupErrors.push(`Notification cleanup notice: ${notifErr?.message}`);
    }

    // 6. Delete push notification subscription
    try {
      const subRef = doc(db, 'push_subscriptions', studentUid);
      await deleteDoc(subRef);
    } catch {}

    // 7. Delete Firestore student profile document
    try {
      const studentDocRef = doc(db, 'students', studentUid);
      await deleteDoc(studentDocRef);
    } catch {
      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/students/${studentUid}`;
      await fetch(restUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${idToken}` },
      });
    }

    // 8. Remove student's personal information and historical entries from Master Excel Workbook
    let excelClearedRow = null;
    try {
      const excelRes = await removeStudentFromMasterWorkbook(studentId, idToken);
      excelClearedRow = excelRes.clearedRow;
    } catch (excelErr: any) {
      cleanupErrors.push(`Master Excel roster cleanup note: ${excelErr?.message}`);
    }

    // 9. Delete Firebase Authentication user account server-side
    try {
      await deleteStudentAuthAccount(studentUid);
    } catch (authErr: any) {
      cleanupErrors.push(`Auth user deletion note: ${authErr?.message}`);
    }

    // 10. Record minimal NON-IDENTIFYING deletion audit log
    // Notice: Contains only opaque deletion job identifier, responsible admin, timestamp, and action.
    // Zero student personal data is stored in the audit record.
    try {
      const auditLogId = `audit_${opaqueJobId}`;
      const minimalAuditRecord: AuditLog = {
        id: auditLogId,
        adminEmail,
        action: 'PERMANENT_STUDENT_DELETION',
        targetStudentId: 'REDACTED',
        targetStudentName: 'REDACTED',
        targetDate: nowIso.split('T')[0],
        newStatus: 'DELETED',
        reason: `Permanent student account deletion executed by administrator. Opaque Job ID: ${opaqueJobId}. Cleaned: ${attendanceDeletedCount} attendance doc(s), ${notifsDeletedCount} notification doc(s).`,
        timestamp: nowIso,
      };

      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/audit_logs/${auditLogId}`;
      await fetch(restUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            id: { stringValue: minimalAuditRecord.id },
            adminEmail: { stringValue: minimalAuditRecord.adminEmail },
            action: { stringValue: minimalAuditRecord.action },
            targetStudentId: { stringValue: 'REDACTED' },
            targetStudentName: { stringValue: 'REDACTED' },
            targetDate: { stringValue: minimalAuditRecord.targetDate },
            newStatus: { stringValue: 'DELETED' },
            reason: { stringValue: minimalAuditRecord.reason },
            timestamp: { stringValue: minimalAuditRecord.timestamp },
          },
        }),
      });
    } catch (auditErr) {
      console.warn('[Delete API] Audit record note:', auditErr);
    }

    return NextResponse.json({
      success: true,
      deletionJobId: opaqueJobId,
      message: `Student account '${studentId}' and all associated personal data have been permanently removed.`,
      attendanceDeletedCount,
      notifsDeletedCount,
      excelClearedRow,
      warnings: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    });
  } catch (error: any) {
    console.error('[Delete API] Student permanent deletion error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to permanently delete student.' },
      { status: 500 }
    );
  }
}
