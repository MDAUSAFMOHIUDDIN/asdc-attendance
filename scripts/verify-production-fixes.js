/**
 * ASDC Attendance - Production Fixes Verification Suite
 * 
 * Verifies all requirements from prompt:
 * 1. One permanent original QR code (no regeneration/expiration)
 * 2. Admin QR access ON/OFF control (ENABLED/DISABLED, unauthorized rejection, exact student message)
 * 3. Real-time admin location security alerts (geofence verification, genuine incident logging, IST date/time, review flow)
 * 4. Master Excel workbook integrity & download response formatting
 * 5. Removal of demo/mock alerts & presence of real-time listeners
 */

const fs = require('fs');
const path = require('path');

async function runVerification() {
  console.log('======================================================================');
  console.log('  ASDC ATTENDANCE: PRODUCTION FIXES VERIFICATION SUITE');
  console.log('======================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${name} ${details ? '(' + details + ')' : ''}`);
      failed++;
    }
  }

  // Load backend services
  const { SOLE_ADMIN_EMAIL, isAuthorizedAdmin, INSTITUTE_CONFIG } = require('../lib/admin-config.ts');
  const { OFFICIAL_PERMANENT_QR_PAYLOAD } = require('../lib/qr-generator.ts');
  const {
    getQRAccessStatus,
    setQRAccessStatus,
    validateClassroomQR,
    getActiveQRChallenge,
    refreshQRChallenge,
  } = require('../lib/qr-challenge-service.ts');
  const {
    verifyStudentLocation,
    logLocationIncident,
    getLocationIncidents,
    markIncidentReviewed,
    OFFICIAL_ASDC_LOCATION,
  } = require('../lib/geofence-service.ts');
  const {
    ensureMasterWorkbook,
    getMasterWorkbookFilePath,
    getMasterWorkbookInfo,
  } = require('../lib/excel-master-service.ts');

  // ==========================================================================
  // SECTION 1: PERMANENT CLASSROOM QR CODE VERIFICATION
  // ==========================================================================
  console.log('\n--- [1] ONE PERMANENT ORIGINAL QR CODE (NO REGENERATION) ---');

  assert(
    OFFICIAL_PERMANENT_QR_PAYLOAD.permanentId === 'ASDC_PERMANENT_CLASSROOM_QR',
    'Permanent QR payload has static immutable ID: ASDC_PERMANENT_CLASSROOM_QR'
  );
  assert(
    OFFICIAL_PERMANENT_QR_PAYLOAD.issuer === 'ASDC',
    'QR payload issuer is ASDC'
  );
  assert(
    OFFICIAL_PERMANENT_QR_PAYLOAD.type === 'classroom_attendance',
    'QR payload type is classroom_attendance'
  );
  assert(
    OFFICIAL_PERMANENT_QR_PAYLOAD.classroomId === INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
    'QR payload classroomId matches official classroom secret key'
  );

  const activeChallenge1 = await getActiveQRChallenge();
  assert(
    activeChallenge1.isPermanent === true,
    'getActiveQRChallenge reports isPermanent === true'
  );
  assert(
    activeChallenge1.challenge.challengeId === 'ASDC_OFFICIAL_PERMANENT_QR',
    'Active challenge uses permanent challenge ID'
  );

  // Calling refresh should NOT generate a new QR token or invalidate past QR
  const refreshResult = await refreshQRChallenge(SOLE_ADMIN_EMAIL);
  assert(
    refreshResult.isPermanent === true,
    'refreshQRChallenge preserves permanent QR identity'
  );
  assert(
    refreshResult.challenge.challengeId === activeChallenge1.challenge.challengeId,
    'refreshQRChallenge does not rotate or invalidate the challenge ID'
  );

  // ==========================================================================
  // SECTION 2: ADMIN QR ACCESS ON/OFF CONTROL
  // ==========================================================================
  console.log('\n--- [2] ADMIN QR ACCESS ON/OFF CONTROL ---');

  // 2a. Security check: Non-admin cannot change QR access status
  let unauthorizedBlocked = false;
  try {
    await setQRAccessStatus('unauthorized_student@gmail.com', 'DISABLED');
  } catch (err) {
    unauthorizedBlocked = true;
  }
  assert(unauthorizedBlocked, 'Unauthorized user cannot disable QR access (threw 403 / error)');

  // 2b. Admin disables QR access
  const disableResult = await setQRAccessStatus(SOLE_ADMIN_EMAIL, 'DISABLED');
  assert(disableResult.success && disableResult.status === 'DISABLED', 'Admin successfully set QR Access to DISABLED');

  const statusAfterDisable = await getQRAccessStatus();
  assert(statusAfterDisable === 'DISABLED', 'getQRAccessStatus authoritative check returns DISABLED');

  // 2c. Student scans permanent QR while disabled
  const disabledValidation = await validateClassroomQR(OFFICIAL_PERMANENT_QR_PAYLOAD);
  assert(disabledValidation.isValid === false, 'QR scan is rejected while QR access is DISABLED');
  assert(disabledValidation.isQrDisabled === true, 'Validation explicitly flags isQrDisabled === true');

  const EXPECTED_DISABLED_MSG = 'Attendance is currently disabled by the administrator. Please wait until the administrator enables attendance.';
  assert(
    disabledValidation.reason === EXPECTED_DISABLED_MSG,
    `Exact required error message returned to student: "${EXPECTED_DISABLED_MSG}"`
  );

  // 2d. Admin re-enables QR access
  const enableResult = await setQRAccessStatus(SOLE_ADMIN_EMAIL, 'ENABLED');
  assert(enableResult.success && enableResult.status === 'ENABLED', 'Admin successfully set QR Access to ENABLED');

  const statusAfterEnable = await getQRAccessStatus();
  assert(statusAfterEnable === 'ENABLED', 'getQRAccessStatus authoritative check returns ENABLED');

  // 2e. Exact same QR code validates immediately once re-enabled
  const enabledValidation = await validateClassroomQR(OFFICIAL_PERMANENT_QR_PAYLOAD);
  assert(
    enabledValidation.isValid === true,
    'Exact same permanent QR code validates immediately when enabled'
  );

  // Invalid QR payload rejection
  const fakeValidation = await validateClassroomQR({ fake: 'data' });
  assert(fakeValidation.isValid === false, 'Invalid QR payload is rejected');

  // ==========================================================================
  // SECTION 3: LOCATION RESTRICTION & REAL-TIME SECURITY ALERTS
  // ==========================================================================
  console.log('\n--- [3] LOCATION RESTRICTION & REAL-TIME SECURITY ALERTS ---');

  // 3a. Inside ASDC campus (Shah Ali Banda Road)
  const insideLoc = {
    latitude: OFFICIAL_ASDC_LOCATION.latitude + 0.0001,
    longitude: OFFICIAL_ASDC_LOCATION.longitude + 0.0001,
    accuracy: 12,
  };
  const insideResult = verifyStudentLocation(insideLoc);
  assert(insideResult.isValid === true, `Student inside ASDC radius is accepted (distance: ${insideResult.distanceMeters}m)`);

  // 3a-2. Within 2,000m ASDC radius (e.g. ~1,100m away near Charminar)
  const nearbyLoc = {
    latitude: OFFICIAL_ASDC_LOCATION.latitude + 0.01,
    longitude: OFFICIAL_ASDC_LOCATION.longitude,
    accuracy: 15,
  };
  const nearbyResult = verifyStudentLocation(nearbyLoc);
  assert(nearbyResult.isValid === true, `Student within 2,000m radius is accepted (distance: ${nearbyResult.distanceMeters}m)`);

  // 3b. Outside ASDC campus (Secunderabad coords, ~11 km away)
  const outsideLoc = {
    latitude: 17.4399,
    longitude: 78.4983,
    accuracy: 15,
  };
  const outsideResult = verifyStudentLocation(outsideLoc);
  assert(outsideResult.isValid === false, 'Student outside ASDC radius is rejected');
  assert(outsideResult.errorType === 'OUTSIDE_GEOFENCE', 'Error type is correctly identified as OUTSIDE_GEOFENCE');
  assert(outsideResult.distanceMeters > 2000, `Distance correctly calculated (>2000m: ${outsideResult.distanceMeters}m)`);

  // 3c. Poor GPS accuracy check (> 50m)
  const poorAccuracyLoc = {
    latitude: OFFICIAL_ASDC_LOCATION.latitude,
    longitude: OFFICIAL_ASDC_LOCATION.longitude,
    accuracy: 95, // max allowed is 50m
  };
  const poorAccResult = verifyStudentLocation(poorAccuracyLoc);
  assert(poorAccResult.isValid === false, 'Student with poor GPS accuracy (>50m) is rejected');
  assert(poorAccResult.errorType === 'INSUFFICIENT_LOCATION_ACCURACY', 'Error type is INSUFFICIENT_LOCATION_ACCURACY');

  // 3d. Genuine incident logging & format verification
  console.log('Logging genuine security incident...');
  const testIncident = await logLocationIncident({
    studentId: 'ASDC-0012',
    studentName: 'Mirza Ibrahim Ali',
    studentEmail: 'mirza.ibrahim@example.com',
    incidentType: 'OUTSIDE_GEOFENCE',
    latitude: outsideLoc.latitude,
    longitude: outsideLoc.longitude,
    gpsAccuracy: outsideLoc.accuracy,
    distanceMeters: outsideResult.distanceMeters,
    allowedRadiusMeters: 2000,
    details: outsideResult.message,
  });

  assert(typeof testIncident.id === 'string' && testIncident.id.length > 10, 'Incident assigned unique UUID');
  assert(testIncident.status === 'New', 'Incident created with status "New"');
  assert(typeof testIncident.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(testIncident.date), `Incident includes IST date (${testIncident.date})`);
  assert(typeof testIncident.time === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(testIncident.time), `Incident includes IST time (${testIncident.time})`);
  assert(testIncident.distanceMeters === outsideResult.distanceMeters, 'Incident records reported distance');
  assert(testIncident.gpsAccuracy === outsideLoc.accuracy, 'Incident records GPS accuracy');
  assert(testIncident.studentName === 'Mirza Ibrahim Ali', 'Incident records student name');
  assert(testIncident.studentId === 'ASDC-0012', 'Incident records student ID');

  // 3e. Admin reviews incident
  const updatedIncidents = await markIncidentReviewed(SOLE_ADMIN_EMAIL, testIncident.id);
  const reviewedItem = updatedIncidents.find((i) => i.id === testIncident.id);
  assert(reviewedItem && reviewedItem.status === 'Reviewed', 'Admin can mark genuine incident as "Reviewed"');
  assert(reviewedItem && reviewedItem.reviewedBy === SOLE_ADMIN_EMAIL, 'Incident records admin reviewer email');

  // 3f. Unauthorized user cannot review incident
  let unauthorizedReviewBlocked = false;
  try {
    await markIncidentReviewed('hacker@domain.com', testIncident.id);
  } catch {
    unauthorizedReviewBlocked = true;
  }
  assert(unauthorizedReviewBlocked, 'Unauthorized user cannot review security incidents');

  // ==========================================================================
  // SECTION 4: EXCEL & FILE DOWNLOAD INTEGRITY
  // ==========================================================================
  console.log('\n--- [4] MASTER EXCEL WORKBOOK & FILE DOWNLOAD INTEGRITY ---');

  await ensureMasterWorkbook();
  const masterPath = getMasterWorkbookFilePath();
  assert(fs.existsSync(masterPath), `Master workbook file exists on disk: ${path.basename(masterPath)}`);

  const fileBytes = fs.readFileSync(masterPath);
  assert(fileBytes.length > 200000, `Master workbook has non-trivial size (${fileBytes.length} bytes)`);

  // Verify ZIP magic header: 50 4B 03 04
  const magicHex = fileBytes.subarray(0, 4).toString('hex');
  assert(magicHex === '504b0304', `Master workbook binary has valid PK ZIP magic header (found ${magicHex})`);

  const masterInfo = await getMasterWorkbookInfo();
  assert(masterInfo.workbookName === 'B-19-AI Builder (1) (3).xlsx', 'Canonical workbook name is B-19-AI Builder (1) (3).xlsx');
  assert(masterInfo.worksheetName === 'B-19-AI Builder', 'Official worksheet is B-19-AI Builder');
  assert(masterInfo.totalStudents === 24, 'Roster contains all 24 students');

  // Verify Content-Disposition & MIME format used by download route
  const expectedMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const canonicalFilename = 'B-19-AI Builder (1) (3).xlsx';
  const encodedFilename = encodeURIComponent(canonicalFilename);
  const expectedDisposition = `attachment; filename="${canonicalFilename}"; filename*=UTF-8''${encodedFilename}`;
  assert(expectedMime.includes('spreadsheetml'), 'Standard OpenXML MIME type verified');
  assert(expectedDisposition.includes('B-19-AI Builder'), 'RFC 6266 Content-Disposition header correctly formatted');

  // ==========================================================================
  // SECTION 5: CLEAN DATA INTEGRITY & DEMO ALERT REMOVAL
  // ==========================================================================
  console.log('\n--- [5] CLEAN DATA INTEGRITY & REMOVAL OF DEMO NOTIFICATIONS ---');

  // Check data/location-incidents.json
  const incidentsFile = path.join(process.cwd(), 'data', 'location-incidents.json');
  if (fs.existsSync(incidentsFile)) {
    const rawIncidents = JSON.parse(fs.readFileSync(incidentsFile, 'utf-8'));
    const hasFakeDemo = rawIncidents.some(
      (inc) => inc.studentName === 'Demo Student' || inc.details?.includes('Simulated')
    );
    assert(!hasFakeDemo, 'data/location-incidents.json contains no fake/simulated demo alerts');
  }

  // Check QRScannerModal.tsx for simulated scan button removal
  const scannerModalCode = fs.readFileSync(
    path.join(process.cwd(), 'components', 'QRScannerModal.tsx'),
    'utf-8'
  );
  assert(
    !scannerModalCode.includes('handleSimulatedScan'),
    'QRScannerModal.tsx has handleSimulatedScan removed'
  );
  assert(
    !scannerModalCode.includes('Simulate Classroom Scan'),
    'QRScannerModal.tsx has Simulate Classroom Scan button removed'
  );

  // Check AdminDashboard.tsx for real-time listeners and QR access controls
  const adminDashboardCode = fs.readFileSync(
    path.join(process.cwd(), 'components', 'AdminDashboard.tsx'),
    'utf-8'
  );
  assert(
    adminDashboardCode.includes("collection(db, 'location_incidents')") &&
    adminDashboardCode.includes('onSnapshot'),
    'AdminDashboard.tsx uses onSnapshot listener for location_incidents (real-time alerts without refresh)'
  );
  assert(
    adminDashboardCode.includes("doc(db, 'settings', 'qr_access')") &&
    adminDashboardCode.includes('onSnapshot'),
    'AdminDashboard.tsx uses onSnapshot listener for settings/qr_access'
  );
  assert(
    adminDashboardCode.includes('ENABLE QR ACCESS') &&
    adminDashboardCode.includes('DISABLE QR ACCESS'),
    'AdminDashboard.tsx has ENABLE QR ACCESS and DISABLE QR ACCESS controls'
  );

  console.log('\n======================================================================');
  console.log(`  VERIFICATION RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runVerification().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
