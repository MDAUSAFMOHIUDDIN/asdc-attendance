import { NextRequest, NextResponse } from 'next/server';
import { reconcileAllDatesInMaster } from '@/lib/excel-master-service';
import { isAuthorizedAdmin, SOLE_ADMIN_EMAIL } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { AttendanceRecord } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    let idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    const body = await request.json().catch(() => ({}));
    if (!idToken && body.idToken) {
      idToken = body.idToken;
    }

    const adminEmail = body.adminEmail || SOLE_ADMIN_EMAIL;

    if (!isAuthorizedAdmin(adminEmail)) {
      return NextResponse.json(
        { error: 'Unauthorized: Only authorized institute administrators can reconcile master Excel records.' },
        { status: 403 }
      );
    }

    let recordsToUse: AttendanceRecord[] = Array.isArray(body.records) ? body.records : [];
    let finalizedDates: string[] = Array.isArray(body.finalizedDates) ? body.finalizedDates : [];

    // If records were not provided in payload, fetch authoritative records from Firestore
    if (recordsToUse.length === 0) {
      // 1. Try Firestore REST if idToken available
      if (idToken) {
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance?pageSize=1000`;
          const res = await fetch(restUrl, {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          if (res.ok) {
            const data = await res.json();
            const docs = data.documents || [];
            for (const d of docs) {
              const f = d.fields || {};
              const id = f.id?.stringValue || d.name?.split('/').pop() || '';
              const studentUid = f.studentUid?.stringValue || '';
              const studentId = f.studentId?.stringValue || '';
              const studentName = f.studentName?.stringValue || '';
              const studentEmail = f.studentEmail?.stringValue || '';
              const classDate = f.classDate?.stringValue || '';
              const batchId = f.batchId?.stringValue || '';
              const status = f.status?.stringValue || 'PRESENT';

              if (studentId && classDate) {
                recordsToUse.push({
                  id,
                  studentUid,
                  studentId,
                  studentName,
                  studentEmail,
                  classDate,
                  batchId,
                  status: status as any,
                  source: (f.source?.stringValue as any) || 'QR_SCAN',
                  verifiedAt: f.verifiedAt?.stringValue || '',
                });
              }
            }
          }
        } catch (restErr) {
          console.warn('[Reconcile API] REST query notice:', restErr);
        }
      }

      // 2. Client SDK fallback
      if (recordsToUse.length === 0) {
        try {
          const snap = await getDocs(collection(db, 'attendance'));
          snap.forEach((d) => {
            recordsToUse.push(d.data() as AttendanceRecord);
          });
        } catch (sdkErr) {
          console.warn('[Reconcile API] SDK query notice:', sdkErr);
        }
      }
    }

    // Determine finalized dates from audit logs if not provided
    if (finalizedDates.length === 0) {
      if (idToken) {
        try {
          const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/audit_logs?pageSize=500`;
          const res = await fetch(restUrl, {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          if (res.ok) {
            const data = await res.json();
            const docs = data.documents || [];
            for (const d of docs) {
              const f = d.fields || {};
              const action = f.action?.stringValue;
              const targetDate = f.targetDate?.stringValue;
              if (action === 'FINALIZE_DAILY_ATTENDANCE' && targetDate) {
                finalizedDates.push(targetDate);
              }
            }
          }
        } catch (err) {}
      }

      try {
        const auditSnap = await getDocs(
          query(collection(db, 'audit_logs'), where('action', '==', 'FINALIZE_DAILY_ATTENDANCE'))
        );
        auditSnap.forEach((d) => {
          const targetDate = d.data().targetDate;
          if (targetDate && !finalizedDates.includes(targetDate)) {
            finalizedDates.push(targetDate);
          }
        });
      } catch (err) {}
    }

    // Execute Master Workbook Reconcile across ALL dates
    const result = await reconcileAllDatesInMaster({
      allAttendanceRecords: recordsToUse,
      finalizedDates,
      adminEmail,
      idToken,
    });

    return NextResponse.json({
      success: true,
      message: result.message,
      syncedDates: result.syncedDates,
      totalUpdatedCells: result.totalUpdatedCells,
      dateSummary: result.dateSummary,
      version: result.version,
    });
  } catch (error: any) {
    console.error('[Reconcile API] Reconcile error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to reconcile master Excel attendance records.' },
      { status: 500 }
    );
  }
}
