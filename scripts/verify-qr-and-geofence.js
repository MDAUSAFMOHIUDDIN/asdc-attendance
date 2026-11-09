/**
 * Automated Verification Script for:
 * 1. Admin QR Code Refresh & Invalidation
 * 2. Institute Geofence & Location Restrictions
 * 3. Canonical Master Excel Register Protection
 */

const http = require('http');

const BASE_URL = 'http://localhost:3000';
const ADMIN_EMAIL = 'mdausafmohiuddin@gmail.com';
const UNAUTHORIZED_EMAIL = 'attacker@example.com';

// ASDC Verified Coordinates
const ASDC_LAT = 17.34668005;
const ASDC_LON = 78.46089325;

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    throw new Error(message);
  }
  console.log(`✅ PASSED: ${message}`);
}

async function runTests() {
  console.log('================================================================');
  console.log('🚀 ASDC ATTENDANCE — QR REFRESH & GEOFENCING TEST SUITE');
  console.log('================================================================\n');

  // TEST 1: Geofence Config Retrieval
  console.log('--- TEST GROUP 1: GEOFENCE CONFIGURATION ---');
  const geofenceRes = await makeRequest('/api/attendance/geofence/config');
  assert(geofenceRes.status === 200, 'Geofence config returns HTTP 200');
  assert(geofenceRes.data.success === true, 'Geofence config returns success: true');
  assert(Math.abs(geofenceRes.data.config.latitude - ASDC_LAT) < 0.0001, 'Center latitude matches ASDC pin (17.34668005)');
  assert(Math.abs(geofenceRes.data.config.longitude - ASDC_LON) < 0.0001, 'Center longitude matches ASDC pin (78.46089325)');
  assert(geofenceRes.data.config.radiusMeters === 100, 'Initial radius is 100 metres');
  assert(geofenceRes.data.config.maxAccuracyMeters === 50, 'Initial max accuracy threshold is 50 metres');

  // TEST 2: Active QR Challenge Retrieval
  console.log('\n--- TEST GROUP 2: ACTIVE QR CHALLENGE RETRIEVAL ---');
  const activeQrRes = await makeRequest(`/api/attendance/qr/active?adminEmail=${encodeURIComponent(ADMIN_EMAIL)}`);
  assert(activeQrRes.status === 200, 'Active QR returns HTTP 200 for admin');
  assert(activeQrRes.data.success === true, 'Active QR challenge is loaded');
  assert(typeof activeQrRes.data.challenge.challengeId === 'string' && activeQrRes.data.challenge.challengeId.length > 10, 'Challenge ID is an opaque string');
  assert(activeQrRes.data.challenge.status === 'ACTIVE', 'Challenge status is ACTIVE');
  assert(activeQrRes.data.qrDataUrl.startsWith('data:image/png;base64,'), 'QR data URL is valid PNG Data URL');
  const initialChallengeId = activeQrRes.data.challenge.challengeId;
  const initialQrPayload = activeQrRes.data.challenge.qrPayload;

  // TEST 3: Unauthorized QR Refresh Attempt
  console.log('\n--- TEST GROUP 3: SECURITY AUTHORIZATION CHECKS ---');
  const unauthRefreshRes = await makeRequest('/api/attendance/qr/refresh', 'POST', {
    adminEmail: UNAUTHORIZED_EMAIL,
  });
  assert(unauthRefreshRes.status === 403, 'Unauthorized email is blocked from refreshing QR (HTTP 403)');

  // TEST 4: Authorized QR Refresh by mdausafmohiuddin@gmail.com
  console.log('\n--- TEST GROUP 4: AUTHORIZED QR REFRESH & ATOMIC INVALIDATION ---');
  const authRefreshRes = await makeRequest('/api/attendance/qr/refresh', 'POST', {
    adminEmail: ADMIN_EMAIL,
  });
  assert(authRefreshRes.status === 200, 'Authorized admin successfully refreshes QR (HTTP 200)');
  assert(authRefreshRes.data.success === true, 'Refresh response reports success');
  assert(authRefreshRes.data.challenge.challengeId !== initialChallengeId, 'New challenge ID differs from previous challenge ID');
  assert(authRefreshRes.data.previousChallengeId === initialChallengeId, 'Previous challenge ID matches initial challenge ID');

  const refreshedChallengeId = authRefreshRes.data.challenge.challengeId;
  const refreshedQrPayload = authRefreshRes.data.challenge.qrPayload;

  // Check that fetching active QR now reflects new challenge
  const activeAfterRefresh = await makeRequest(`/api/attendance/qr/active?adminEmail=${encodeURIComponent(ADMIN_EMAIL)}`);
  assert(activeAfterRefresh.data.challenge.challengeId === refreshedChallengeId, 'Active QR is updated atomically to new challenge');
  const invalidatedEntry = activeAfterRefresh.data.history.find(h => h.challengeId === initialChallengeId);
  assert(invalidatedEntry && invalidatedEntry.status === 'INVALIDATED', 'Previous challenge marked as INVALIDATED in audit history');

  // TEST 5: Student Submits Old/Invalidated QR
  console.log('\n--- TEST GROUP 5: OLD / INVALIDATED QR REJECTION ---');
  const oldQrSubmit = await makeRequest('/api/attendance/submit', 'POST', {
    studentUid: 'test_student_uid_1',
    studentId: 'ASDC-0001',
    studentName: 'Mohammed Ausaf Mohiuddin',
    studentEmail: 'mdausafmohiuddin@gmail.com',
    batchId: 'ai-builder-mastery',
    rawQrContent: JSON.stringify(initialQrPayload), // OLD challenge!
    location: {
      latitude: ASDC_LAT,
      longitude: ASDC_LON,
      accuracy: 10,
    },
  });
  console.log('Test 5 Status:', oldQrSubmit.status, 'Data:', oldQrSubmit.data);
  assert(oldQrSubmit.status === 400, 'Submitting invalidated QR is rejected with HTTP 400');
  assert(oldQrSubmit.data.isExpiredChallenge === true, 'Response flags isExpiredChallenge: true');

  // TEST 6: Student Submits Outside Geofence
  console.log('\n--- TEST GROUP 6: OUTSIDE GEOFENCE ATTENDANCE REJECTION ---');
  // Coordinates in Secunderabad (~15km north of ASDC)
  const outsideLat = 17.440080;
  const outsideLon = 78.498270;
  const outsideSubmit = await makeRequest('/api/attendance/submit', 'POST', {
    studentUid: 'test_student_uid_2',
    studentId: 'ASDC-0002',
    studentName: 'Zubair Ahmed',
    studentEmail: 'zubair@example.com',
    batchId: 'ai-builder-mastery',
    rawQrContent: JSON.stringify(refreshedQrPayload), // ACTIVE challenge
    location: {
      latitude: outsideLat,
      longitude: outsideLon,
      accuracy: 12,
    },
  });
  assert(outsideSubmit.status === 403, 'Submitting outside geofence is rejected with HTTP 403');
  assert(outsideSubmit.data.errorType === 'OUTSIDE_GEOFENCE', 'Error type is OUTSIDE_GEOFENCE');
  assert(outsideSubmit.data.distanceMeters > 5000, `Distance properly calculated (~${Math.round(outsideSubmit.data.distanceMeters)}m)`);
  assert(outsideSubmit.data.allowedRadiusMeters === 100, 'Allowed radius is reported as 100m');

  // TEST 7: Student Submits with Poor GPS Accuracy
  console.log('\n--- TEST GROUP 7: INSUFFICIENT GPS ACCURACY REJECTION ---');
  const poorAccuracySubmit = await makeRequest('/api/attendance/submit', 'POST', {
    studentUid: 'test_student_uid_3',
    studentId: 'ASDC-0003',
    studentName: 'Syed Imran',
    studentEmail: 'syed@example.com',
    batchId: 'ai-builder-mastery',
    rawQrContent: JSON.stringify(refreshedQrPayload),
    location: {
      latitude: ASDC_LAT,
      longitude: ASDC_LON,
      accuracy: 95, // Above 50m max threshold!
    },
  });
  console.log('Test 7 Result Status:', poorAccuracySubmit.status, 'Data:', poorAccuracySubmit.data);
  assert(poorAccuracySubmit.status === 403, 'Submitting with GPS accuracy > 50m is rejected (HTTP 403)');
  assert(poorAccuracySubmit.data.errorType === 'INSUFFICIENT_LOCATION_ACCURACY', 'Error type is INSUFFICIENT_LOCATION_ACCURACY');

  // TEST 8: Location Security Incidents Logged in Backend
  console.log('\n--- TEST GROUP 8: SECURITY INCIDENTS AUDIT VERIFICATION ---');
  const incidentsRes = await makeRequest(`/api/attendance/incidents?adminEmail=${encodeURIComponent(ADMIN_EMAIL)}`);
  assert(incidentsRes.status === 200, 'Admin can view location security incidents (HTTP 200)');
  assert(Array.isArray(incidentsRes.data.incidents), 'Incidents returned as an array');
  const hasOutsideIncident = incidentsRes.data.incidents.some(i => i.incidentType === 'OUTSIDE_GEOFENCE' && i.studentId === 'ASDC-0002');
  assert(hasOutsideIncident, 'OUTSIDE_GEOFENCE incident for ASDC-0002 successfully recorded');
  const hasInvalidQrIncident = incidentsRes.data.incidents.some(i => i.incidentType === 'INVALID_QR_CHALLENGE' && i.studentId === 'ASDC-0001');
  assert(hasInvalidQrIncident, 'INVALID_QR_CHALLENGE incident for ASDC-0001 successfully recorded');

  // TEST 9: Incident Review by Admin
  console.log('\n--- TEST GROUP 9: ADMIN INCIDENT REVIEW ---');
  const incidentToReview = incidentsRes.data.incidents[0];
  const reviewRes = await makeRequest('/api/attendance/incidents', 'POST', {
    adminEmail: ADMIN_EMAIL,
    incidentId: incidentToReview.id,
    action: 'review',
  });
  assert(reviewRes.status === 200, 'Incident reviewed successfully');
  const reviewedItem = reviewRes.data.incidents.find(i => i.id === incidentToReview.id);
  assert(reviewedItem.status === 'Reviewed', 'Incident status updated to Reviewed');
  assert(reviewedItem.reviewedBy === ADMIN_EMAIL, 'Incident reviewedBy stamped with admin email');

  // TEST 10: Valid Student Attendance (Inside ASDC Geofence + Active QR)
  console.log('\n--- TEST GROUP 10: VALID IN-BOUNDS ATTENDANCE SUBMISSION ---');
  // Student 1 (MOHD ABDUL QAVI from B-19 register)
  // Distance ~15 meters from center
  const validLat = ASDC_LAT + 0.0001;
  const validLon = ASDC_LON + 0.00008;
  const validSubmit = await makeRequest('/api/attendance/submit', 'POST', {
    studentUid: 'student_qavi_b19',
    studentId: 'B19-001',
    studentName: 'MOHD ABDUL QAVI',
    studentEmail: 'abdulqavi@example.com',
    batchId: 'ai-builder-mastery',
    rawQrContent: JSON.stringify(refreshedQrPayload),
    location: {
      latitude: validLat,
      longitude: validLon,
      accuracy: 12,
    },
  });
  console.log('validSubmit Result Status:', validSubmit.status, 'Data:', validSubmit.data);
  assert(validSubmit.status === 200, 'Valid in-bounds attendance submission accepted with HTTP 200');
  assert(validSubmit.data.success === true, 'Submission returns success: true');
  assert(validSubmit.data.record.status === 'PRESENT', 'Student marked PRESENT');
  assert(validSubmit.data.distanceMeters < 50, `Student verified within campus (~${Math.round(validSubmit.data.distanceMeters)}m)`);
  assert(validSubmit.data.masterExcel.success === true, 'Canonical Master Excel register successfully updated');

  // TEST 11: Master Excel Verification
  console.log('\n--- TEST GROUP 11: CANONICAL MASTER EXCEL REGISTER VERIFICATION ---');
  const todayDate = validSubmit.data.record.classDate;
  const excelDataRes = await makeRequest(
    `/api/attendance/master-excel/data?adminEmail=${encodeURIComponent(ADMIN_EMAIL)}&date=${todayDate}`
  );
  assert(excelDataRes.status === 200, 'Master Excel data retrieved for today');
  assert(Array.isArray(excelDataRes.data.records), 'Master Excel data records is an array');
  const updatedRecord = excelDataRes.data.records.find(r => r.row === validSubmit.data.masterExcel.row);
  assert(updatedRecord && updatedRecord.status === 'P', `Student in row ${validSubmit.data.masterExcel.row} (${updatedRecord?.name}) verified marked P in Canonical Master Excel Register`);

  // TEST 12: Duplicate Prevention
  console.log('\n--- TEST GROUP 12: DUPLICATE PREVENTION ---');
  const dupSubmit = await makeRequest('/api/attendance/submit', 'POST', {
    studentUid: 'student_qavi_b19',
    studentId: 'B19-001',
    studentName: 'MOHD ABDUL QAVI',
    studentEmail: 'abdulqavi@example.com',
    batchId: 'ai-builder-mastery',
    rawQrContent: JSON.stringify(refreshedQrPayload),
    location: {
      latitude: validLat,
      longitude: validLon,
      accuracy: 12,
    },
  });
  assert(dupSubmit.status === 200, 'Duplicate request safely handled with HTTP 200');
  assert(dupSubmit.data.alreadyRecorded === true, 'Response indicates alreadyRecorded: true');

  console.log('\n================================================================');
  console.log('🎉 ALL 12 TEST GROUPS PASSED WITH ZERO ERRORS!');
  console.log('   - Admin QR Refresh & Invalidation: Fully Functional');
  console.log('   - ASDC Geofence (100m) & GPS Accuracy (50m): Fully Enforced');
  console.log('   - Location Security Incidents & Admin Review: Active');
  console.log('   - Canonical Master Excel Register: 100% Intact and Synchronized');
  console.log('================================================================');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed with error:', err);
  process.exit(1);
});
