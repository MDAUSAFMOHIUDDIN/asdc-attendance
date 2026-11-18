import { NextRequest, NextResponse } from 'next/server';
import { getISTTimeInfo } from '@/lib/date-utils';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { AttendanceRecord, AttendanceStatus, ClassroomQRPayload } from '@/lib/types';
import { syncAttendanceRecordToExcel } from '@/lib/excel-master-service';
import { isQRAccessEnabled, QR_ACCESS_DISABLED_MESSAGE } from '@/lib/qr-challenge-service';
import { verifyStudentLocation, logLocationIncident } from '@/lib/geofence-service';
import { verifyAuthToken } from '@/lib/firebase-admin';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1].trim() : null;

    // 1. Strict Token Requirement: Reject missing authentication tokens
    if (!idToken) {
      return NextResponse.json(
        { error: 'Missing authentication token. You must be signed in to submit attendance.' },
        { status: 401 }
      );
    }

    // 2. Verify token on trusted backend
    const authResult = await verifyAuthToken(idToken);
    if (!authResult.valid || !authResult.user) {
      return NextResponse.json(
        { error: authResult.error || 'Invalid or expired authentication token. Please sign in again.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const {
      studentUid,
      studentId,
      studentName,
      studentEmail,
      batchId,
      rawQrContent,
      location, // { latitude: number, longitude: number, accuracy: number }
    } = body;

    // 3. Basic validation
    if (!studentUid || !studentId || !studentName || !studentEmail || !rawQrContent) {
      return NextResponse.json(
        { error: 'Missing required student or QR scan payload fields.' },
        { status: 400 }
      );
    }

    // 4. Verify that authenticated UID matches the registered student
    if (authResult.user.uid !== studentUid) {
      return NextResponse.json(
        { error: 'Security rejection: Authenticated user account does not match the student submitting attendance.' },
        { status: 403 }
      );
    }

    if (authResult.user.email && authResult.user.email.toLowerCase().trim() !== studentEmail.toLowerCase().trim()) {
      return NextResponse.json(
        { error: 'Security rejection: Authenticated email does not match registered student email.' },
        { status: 403 }
      );
    }

    // 5. CRITICAL BACKEND RULE: Check Admin QR Access ON/OFF status first (authoritative database & memory)
    const qrAccessEnabled = await isQRAccessEnabled(true);
    if (!qrAccessEnabled) {
      return NextResponse.json(
        {
          error: QR_ACCESS_DISABLED_MESSAGE,
          errorType: 'QR_ACCESS_DISABLED',
          isQrDisabled: true,
        },
        { status: 403 }
      );
    }

    // 6. Authoritative Date in Asia/Kolkata (Anytime attendance allowed)
    const evaluationTime = new Date();
    const istInfo = getISTTimeInfo(evaluationTime);
    const classDate = istInfo.dateString; // YYYY-MM-DD

    // 7. Permanent QR Payload parsing & structure verification
    let qrData: ClassroomQRPayload;
    try {
      qrData = typeof rawQrContent === 'string' ? JSON.parse(rawQrContent) : rawQrContent;
    } catch {
      return NextResponse.json(
        { error: 'Invalid QR code. The scanned QR is not valid JSON.' },
        { status: 400 }
      );
    }

    if (
      qrData.issuer !== 'ASDC' ||
      qrData.type !== 'classroom_attendance' ||
      qrData.classroomId !== INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY
    ) {
      return NextResponse.json(
        { error: 'Invalid Classroom QR. Scanned QR code does not match official ASDC AI Builder Mastery classroom.' },
        { status: 400 }
      );
    }

    // 8. Batch restriction check
    if (
      qrData.batchId !== INSTITUTE_CONFIG.DEFAULT_BATCH_ID ||
      batchId !== INSTITUTE_CONFIG.DEFAULT_BATCH_ID
    ) {
      return NextResponse.json(
        {
          error: `Unauthorized Batch: Only students enrolled in '${INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}' may submit attendance.`,
        },
        { status: 403 }
      );
    }

    // 9. Authoritative Backend Geofence Verification (2000m permitted radius, max 50m GPS accuracy)
    const locResult = verifyStudentLocation(location);
    if (!locResult.isValid) {
      try {
        await logLocationIncident({
          studentId,
          studentName,
          studentEmail,
          incidentType: locResult.errorType || 'OUTSIDE_GEOFENCE',
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          gpsAccuracy: location?.accuracy ?? null,
          distanceMeters: locResult.distanceMeters > 0 ? locResult.distanceMeters : null,
          allowedRadiusMeters: locResult.config.radiusMeters,
          details: locResult.message,
        });
      } catch (logErr) {
        console.error('[Submit] Failed to record security incident in database:', logErr);
      }

      return NextResponse.json(
        {
          error: locResult.message,
          errorType: locResult.errorType,
          distanceMeters: locResult.distanceMeters,
          allowedRadiusMeters: locResult.config.radiusMeters,
          maxAccuracyMeters: locResult.config.maxAccuracyMeters,
        },
        { status: 403 }
      );
    }

    // 10. Check if date is declared a holiday
    try {
      const holidayRef = doc(db, 'holidays', classDate);
      const holidaySnap = await getDoc(holidayRef);
      if (holidaySnap.exists()) {
        const holidayData = holidaySnap.data();
        return NextResponse.json(
          {
            error: `Attendance is not active today. Date ${classDate} is declared a holiday: ${
              holidayData?.title || 'Official Holiday'
            }.`,
            isHoliday: true,
          },
          { status: 400 }
        );
      }
    } catch (err) {
      console.warn('Holiday check notice:', err);
    }

    // 11. Authoritative Duplicate prevention in Database
    const attendanceDocId = `${studentUid}_${classDate}`;
    let existingDbRecord: AttendanceRecord | null = null;

    try {
      const checkUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${attendanceDocId}`;
      const checkRes = await fetch(checkUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const fields = checkData.fields || {};
        existingDbRecord = {
          id: attendanceDocId,
          studentUid,
          studentId,
          studentName,
          studentEmail,
          classDate,
          batchId: fields.batchId?.stringValue || INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
          status: (fields.status?.stringValue as AttendanceStatus) || 'PRESENT',
          source: (fields.source?.stringValue as any) || 'QR_SCAN',
          verifiedAt: fields.verifiedAt?.stringValue || evaluationTime.toISOString(),
          submittedAt: fields.submittedAt?.stringValue || evaluationTime.toISOString(),
        };
        return NextResponse.json({
          success: true,
          alreadyRecorded: true,
          backendDbConfirmed: true,
          message: `Attendance already recorded for today (${classDate}) as ${existingDbRecord.status}.`,
          record: existingDbRecord,
        });
      }
    } catch (dbCheckErr) {
      console.warn('[Submit] Firestore REST duplicate check notice:', dbCheckErr);
    }

    // 12. CRITICAL RACE-CONDITION CHECK: Verify QR Access immediately before committing
    const raceCheckEnabled = await isQRAccessEnabled(true);
    if (!raceCheckEnabled) {
      return NextResponse.json(
        {
          error: QR_ACCESS_DISABLED_MESSAGE,
          errorType: 'QR_ACCESS_DISABLED',
          isQrDisabled: true,
        },
        { status: 403 }
      );
    }

    // 13. Prepare schema-compliant authoritative attendance record
    const nowIso = new Date().toISOString();
    const eventId = `att_${Date.now()}_${studentId}_${Math.random().toString(36).substring(2, 7)}`;
    const newRecord: AttendanceRecord = {
      id: attendanceDocId,
      studentUid,
      studentId,
      studentName,
      studentEmail,
      classDate,
      batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
      status: 'PRESENT',
      source: 'QR_SCAN',
      verifiedAt: nowIso,
      submittedAt: nowIso,
      timestamp: nowIso,
      eventId,
      locationVerification: {
        verified: true,
        distanceMeters: Math.round(locResult.distanceMeters),
        gpsAccuracy: location?.accuracy ?? null,
        withinGeofence: true,
      },
      qrValidation: {
        verified: true,
        issuer: qrData.issuer,
        type: qrData.type,
      },
      dbCommitStatus: 'COMMITTED',
      excelSyncStatus: 'PENDING',
      finalizationStatus: 'UNFINALIZED',
    };

    // 14. COMMIT RECORD TO FIRESTORE FIRST AND VERIFY
    // Must never return attendance success when the database write fails
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${attendanceDocId}`;
    const fields: Record<string, any> = {
      id: { stringValue: newRecord.id },
      studentUid: { stringValue: newRecord.studentUid },
      studentId: { stringValue: newRecord.studentId },
      studentName: { stringValue: newRecord.studentName },
      studentEmail: { stringValue: newRecord.studentEmail },
      classDate: { stringValue: newRecord.classDate },
      batchId: { stringValue: newRecord.batchId },
      status: { stringValue: newRecord.status },
      source: { stringValue: newRecord.source },
      verifiedAt: { stringValue: newRecord.verifiedAt },
      submittedAt: { stringValue: newRecord.submittedAt || nowIso },
      timestamp: { stringValue: nowIso },
      eventId: { stringValue: eventId },
      dbCommitStatus: { stringValue: 'COMMITTED' },
      excelSyncStatus: { stringValue: 'PENDING' },
      finalizationStatus: { stringValue: 'UNFINALIZED' },
    };

    const restRes = await fetch(firestoreUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!restRes.ok) {
      const errText = await restRes.text();
      console.error('[Submit] Firestore database write failed:', errText);
      return NextResponse.json(
        {
          error: 'Database commit failed. Attendance could not be saved to Firestore.',
          backendDbConfirmed: false,
        },
        { status: 500 }
      );
    }

    const backendDbConfirmed = true;
    console.log(`[Submit] Authoritative record confirmed in Firestore for ${studentId} on ${classDate}`);

    // 15. Correct database-to-Excel pipeline: Durable Excel synchronization job
    // Database attendance and Excel synchronization remain separate operations.
    // If Excel synchronization fails, actual database attendance record is preserved.
    let excelSyncStatus: 'SYNCED' | 'PENDING' = 'PENDING';
    let masterExcelResult = null;

    try {
      masterExcelResult = await syncAttendanceRecordToExcel(newRecord, idToken);
      excelSyncStatus = 'SYNCED';
      newRecord.excelSyncStatus = 'SYNCED';
    } catch (excelErr: any) {
      console.warn('[Submit] Excel synchronization deferred (database record is safe):', excelErr?.message);
      excelSyncStatus = 'PENDING';
      newRecord.excelSyncStatus = 'PENDING';
    }

    return NextResponse.json({
      success: true,
      authorized: true,
      alreadyRecorded: false,
      backendDbConfirmed,
      attendanceStatus: 'RECORDED',
      excelSyncStatus,
      message: `Successfully marked PRESENT for ${classDate} at ${istInfo.timeString} IST. Distance: ${Math.round(
        locResult.distanceMeters
      )}m.`,
      record: newRecord,
      distanceMeters: locResult.distanceMeters,
      masterExcel: masterExcelResult,
    });
  } catch (error) {
    console.error('Attendance submission error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal attendance processing error.' },
      { status: 500 }
    );
  }
}
