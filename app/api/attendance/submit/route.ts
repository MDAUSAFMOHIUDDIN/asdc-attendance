import { NextRequest, NextResponse } from 'next/server';
import { getISTTimeInfo } from '@/lib/date-utils';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { AttendanceRecord, ClassroomQRPayload } from '@/lib/types';
import { recordStudentAttendanceInMaster } from '@/lib/excel-master-service';
import { validateQRChallenge } from '@/lib/qr-challenge-service';
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

    // 2. Authoritative Date in Asia/Kolkata (Anytime attendance allowed)
    const evaluationTime = new Date();
    const istInfo = getISTTimeInfo(evaluationTime);
    const classDate = istInfo.dateString; // YYYY-MM-DD

    // 3. QR Payload parsing & structure verification
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
        { error: 'Invalid Classroom QR. Scanned QR code does not match ASDC AI Builder Mastery classroom.' },
        { status: 400 }
      );
    }

    // 4. Batch restriction check
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

    // 5. Authoritative Backend Validation of Active QR Challenge
    const challengeValidation = validateQRChallenge(qrData.challengeId);
    if (!challengeValidation.isValid) {
      // Log incident: Invalid / Expired QR challenge
      logLocationIncident({
        studentId,
        studentName,
        studentEmail,
        incidentType: 'INVALID_QR_CHALLENGE',
        challengeId: qrData.challengeId || null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        gpsAccuracy: location?.accuracy ?? null,
        details: challengeValidation.reason || 'Invalid or expired QR challenge submitted.',
      });

      return NextResponse.json(
        {
          error: challengeValidation.reason || 'Invalid or expired QR code. Please scan the current active classroom QR.',
          isExpiredChallenge: true,
        },
        { status: 400 }
      );
    }

    // 6. Authoritative Backend Geofence Verification
    const locResult = verifyStudentLocation(location);
    if (!locResult.isValid) {
      // Log location security incident
      logLocationIncident({
        studentId,
        studentName,
        studentEmail,
        incidentType: locResult.errorType || 'OUTSIDE_GEOFENCE',
        challengeId: qrData.challengeId || null,
        latitude: location?.latitude ?? null,
        longitude: location?.longitude ?? null,
        gpsAccuracy: location?.accuracy ?? null,
        distanceMeters: locResult.distanceMeters > 0 ? locResult.distanceMeters : null,
        allowedRadiusMeters: locResult.config.radiusMeters,
        details: locResult.message,
      });

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

    // 8. Duplicate prevention in Database
    const attendanceDocId = `${studentUid}_${classDate}`;
    const attendanceRef = doc(db, 'attendance', attendanceDocId);
    try {
      const existingSnap = await getDoc(attendanceRef);
      if (existingSnap.exists()) {
        const existingRecord = existingSnap.data() as AttendanceRecord;
        return NextResponse.json({
          success: false,
          alreadyRecorded: true,
          message: `Attendance already recorded for today (${classDate}) as ${existingRecord.status}.`,
          record: existingRecord,
        });
      }
    } catch (dbReadErr) {
      console.warn('Firestore duplicate check notice:', dbReadErr);
    }

    // 9. Write verified attendance record to Canonical Master Excel Workbook
    let masterExcelResult;
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
    } catch (excelErr) {
      console.error('Master Excel synchronization error:', excelErr);
      return NextResponse.json(
        {
          error: `Attendance verification failed in master register: ${
            excelErr instanceof Error ? excelErr.message : 'Master workbook update failed.'
          }`,
        },
        { status: 500 }
      );
    }

    // 10. Write verified attendance record to database with trusted timestamp & geolocation audit
    const nowIso = new Date().toISOString();
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
    };

    try {
      await setDoc(attendanceRef, {
        ...newRecord,
        challengeId: qrData.challengeId,
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy,
          distanceMeters: locResult.distanceMeters,
        },
      });
    } catch (dbWriteErr) {
      console.warn('Firestore attendance write notice (offline or rules):', dbWriteErr);
    }

    const isAlreadyRecorded = Boolean(masterExcelResult?.alreadyRecorded);

    return NextResponse.json({
      success: true,
      alreadyRecorded: isAlreadyRecorded,
      message: isAlreadyRecorded
        ? `Attendance already recorded for today (${classDate}) as PRESENT in Master Excel register.`
        : `Successfully marked PRESENT in Master Excel Register and Database for ${classDate} at ${istInfo.timeString} IST. Distance from ASDC: ${Math.round(
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
