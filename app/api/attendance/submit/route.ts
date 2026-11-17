import { NextRequest, NextResponse } from 'next/server';
import { getISTTimeInfo } from '@/lib/date-utils';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db, FIREBASE_CONFIG } from '@/lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { AttendanceRecord, AttendanceStatus, ClassroomQRPayload } from '@/lib/types';
import { recordStudentAttendanceInMaster } from '@/lib/excel-master-service';
import { getQRAccessStatus, isQRAccessEnabled, QR_ACCESS_DISABLED_MESSAGE } from '@/lib/qr-challenge-service';
import { verifyStudentLocation, logLocationIncident } from '@/lib/geofence-service';

export async function POST(request: NextRequest) {
  try {
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

    // 1. Basic validation
    if (!studentUid || !studentId || !studentName || !studentEmail || !rawQrContent) {
      return NextResponse.json(
        { error: 'Missing required student or QR scan payload fields.' },
        { status: 400 }
      );
    }

    // 2. CRITICAL BACKEND RULE: Check Admin QR Access ON/OFF status first (authoritative database & memory)
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

    // 3. Authoritative Date in Asia/Kolkata (Anytime attendance allowed)
    const evaluationTime = new Date();
    const istInfo = getISTTimeInfo(evaluationTime);
    const classDate = istInfo.dateString; // YYYY-MM-DD

    // 4. Permanent QR Payload parsing & structure verification
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

    // 5. Batch restriction check
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

    // 6. Authoritative Backend Geofence Verification (2000m permitted radius, max 50m GPS accuracy)
    const locResult = verifyStudentLocation(location);
    if (!locResult.isValid) {
      // Record genuine incident in backend database with safe retry handling
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

    // 7. Check if date is declared a holiday
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

    // 8. Authoritative Duplicate prevention in Database
    const attendanceDocId = `${studentUid}_${classDate}`;
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    const idToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1].trim() : null;

    // Check directly via authenticated REST API if ID token is provided
    let alreadyRecordedInDb = false;
    let existingDbRecord: AttendanceRecord | null = null;

    if (idToken) {
      try {
        const checkUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/attendance/${attendanceDocId}`;
        const checkRes = await fetch(checkUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${idToken}`,
          },
        });
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          alreadyRecordedInDb = true;
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
    }

    // Secondary client SDK check
    try {
      const attendanceRef = doc(db, 'attendance', attendanceDocId);
      const existingSnap = await getDoc(attendanceRef);
      if (existingSnap.exists()) {
        const existingRecord = existingSnap.data() as AttendanceRecord;
        return NextResponse.json({
          success: true,
          alreadyRecorded: true,
          backendDbConfirmed: true,
          message: `Attendance already recorded for today (${classDate}) as ${existingRecord.status}.`,
          record: existingRecord,
        });
      }
    } catch (dbReadErr) {
      // Handled via REST check
    }

    // 9. Synchronize attendance record with Canonical Master Excel Register
    // Note: Excel sync has separate status from authoritative database attendance
    let excelSyncStatus: 'SYNCED' | 'PENDING' = 'PENDING';
    let masterExcelResult = null;
    try {
      masterExcelResult = await recordStudentAttendanceInMaster(
        {
          studentId,
          fullName: studentName,
          email: studentEmail,
        },
        classDate,
        'P'
      );
      excelSyncStatus = 'SYNCED';
    } catch (excelErr) {
      console.warn('[Submit] Master Excel synchronization deferred to daily finalization:', excelErr);
      excelSyncStatus = 'PENDING';
    }

    // 10. CRITICAL RACE-CONDITION CHECK: Verify QR Access immediately before committing
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

    // 11. Prepare schema-compliant authoritative attendance record
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
      excelSyncStatus,
      finalizationStatus: 'UNFINALIZED',
    };

    // If student passed Firebase Auth ID token, write to Firestore REST API with student's authenticated context
    let backendDbConfirmed = false;
    if (idToken) {
      try {
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
          excelSyncStatus: { stringValue: excelSyncStatus },
          finalizationStatus: { stringValue: 'UNFINALIZED' },
        };
        const restRes = await fetch(firestoreUrl, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fields }),
        });
        if (restRes.ok) {
          backendDbConfirmed = true;
          console.log(`[Submit] Authoritative record successfully committed to Firestore for ${studentId} on ${classDate}`);
        } else {
          const errBody = await restRes.text();
          console.warn('[Submit] Firestore REST direct write note:', errBody);
          newRecord.dbCommitStatus = 'PENDING';
        }
      } catch (restErr) {
        console.warn('[Submit] Firestore REST API write notice:', restErr);
        newRecord.dbCommitStatus = 'PENDING';
      }
    }

    const isAlreadyRecorded = Boolean(masterExcelResult?.alreadyRecorded);

    return NextResponse.json({
      success: true,
      authorized: true,
      alreadyRecorded: isAlreadyRecorded,
      backendDbConfirmed,
      attendanceStatus: 'RECORDED',
      excelSyncStatus,
      message: isAlreadyRecorded
        ? `Attendance already recorded for today (${classDate}) as PRESENT.`
        : `Successfully marked PRESENT for ${classDate} at ${istInfo.timeString} IST. Distance: ${Math.round(
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
