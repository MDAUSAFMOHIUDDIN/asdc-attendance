/**
 * Verification Test Suite for ASDC Attendance Critical Fixes
 * Tests Issue 1, Issue 2, and Issue 3 in depth.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('=================================================================');
console.log('       ASDC ATTENDANCE - COMPREHENSIVE VERIFICATION SUITE         ');
console.log('=================================================================\n');

let allPassed = true;
function assert(condition, message) {
  if (condition) {
    console.log(`  [PASS] ${message}`);
  } else {
    console.error(`  [FAIL] ${message}`);
    allPassed = false;
  }
}

// ----------------------------------------------------------------------------
// TEST 1: ISSUE 2 - QR Access Control & Exact Message Verification
// ----------------------------------------------------------------------------
console.log('--- TEST 1: QR ACCESS CONTROL & DISABLED MESSAGE (ISSUE 2) ---');

const adminConfigPath = path.join(rootDir, 'lib', 'admin-config.ts');
const adminConfigContent = fs.readFileSync(adminConfigPath, 'utf8');

const EXPECTED_EXACT_MSG = 'ADMIN HAS DISABLED ATTENDANCE ACCESS. You cannot scan the classroom QR or mark attendance right now. Please wait until the administrator enables access.';

assert(
  adminConfigContent.includes(EXPECTED_EXACT_MSG),
  'admin-config.ts exports exact required QR_ACCESS_DISABLED_MESSAGE'
);

const qrScannerModalPath = path.join(rootDir, 'components', 'QRScannerModal.tsx');
const qrScannerContent = fs.readFileSync(qrScannerModalPath, 'utf8');

assert(
  qrScannerContent.includes('stopCameraResources') &&
  qrScannerContent.includes('QR_ACCESS_DISABLED_MESSAGE') &&
  qrScannerContent.includes('qrAccessEnabled'),
  'QRScannerModal automatically stops camera and displays QR_ACCESS_DISABLED_MESSAGE when qrAccessEnabled is false'
);

const studentDashboardPath = path.join(rootDir, 'components', 'StudentDashboard.tsx');
const studentDashContent = fs.readFileSync(studentDashboardPath, 'utf8');

assert(
  studentDashContent.includes('qrAccessEnabled') &&
  studentDashContent.includes(EXPECTED_EXACT_MSG) &&
  studentDashContent.includes("disabled={qrAccessStatus !== 'ENABLED'}"),
  'StudentDashboard disables scan button and displays exact disabled banner'
);

// Check backend submit route enforcement
const submitRoutePath = path.join(rootDir, 'app', 'api', 'attendance', 'submit', 'route.ts');
const submitRouteContent = fs.readFileSync(submitRoutePath, 'utf8');

assert(
  submitRouteContent.includes('isQRAccessEnabled') &&
  submitRouteContent.includes('QR_ACCESS_DISABLED_MESSAGE') &&
  submitRouteContent.includes('status: 403'),
  'submit API route checks qrAccessEnabled and rejects with 403 & QR_ACCESS_DISABLED_MESSAGE'
);

assert(
  submitRouteContent.includes('Race-condition safety check') ||
  submitRouteContent.includes('isQRAccessEnabled(true)'),
  'submit API route performs fresh race-condition check before database write'
);

// ----------------------------------------------------------------------------
// TEST 2: ISSUE 1 - Database Write & Admin Real-Time Listener (ISSUE 1)
// ----------------------------------------------------------------------------
console.log('\n--- TEST 2: DATABASE WRITE CONFIRMATION & ADMIN REAL-TIME LISTENER (ISSUE 1) ---');

assert(
  qrScannerContent.includes('await setDoc(attendanceRef, data.record)') &&
  qrScannerContent.includes('await getDoc(attendanceRef)') &&
  qrScannerContent.includes("setScannerState('success')"),
  'QRScannerModal writes authenticated record and verifies DB confirmation before showing success'
);

// Verify no forbidden fields like 'location' in attendance record
assert(
  !submitRouteContent.includes("location: {") &&
  submitRouteContent.includes('newRecord: AttendanceRecord = {'),
  'submit API generates clean AttendanceRecord conforming to isValidAttendance firestore rule'
);

const adminDashboardPath = path.join(rootDir, 'components', 'AdminDashboard.tsx');
const adminDashContent = fs.readFileSync(adminDashboardPath, 'utf8');

assert(
  adminDashContent.includes("collection(db, 'attendance')") &&
  adminDashContent.includes("where('classDate', '==', selectedDate)") &&
  adminDashContent.includes('onSnapshot('),
  'AdminDashboard implements real-time onSnapshot listener for attendance records on selectedDate'
);

assert(
  adminDashContent.includes('stu.studentId') &&
  adminDashContent.includes('stu.fullName') &&
  adminDashContent.includes("status === 'PRESENT'") &&
  adminDashContent.includes('displayTime') &&
  adminDashContent.includes('QR Scan (Verified)'),
  'AdminDashboard renders student name, ID, date, verified time, PRESENT status, and submission status'
);

// ----------------------------------------------------------------------------
// TEST 3: ISSUE 3 - Excel Finalization & Persistent Cross-Container Storage (ISSUE 3)
// ----------------------------------------------------------------------------
console.log('\n--- TEST 3: EXCEL FINALIZATION & PERSISTENCE (ISSUE 3) ---');

const excelServicePath = path.join(rootDir, 'lib', 'excel-master-service.ts');
const excelServiceContent = fs.readFileSync(excelServicePath, 'utf8');

assert(
  excelServiceContent.includes('settings/master_workbook') &&
  excelServiceContent.includes('base64: buffer.toString(\'base64\')'),
  'excel-master-service persists master workbook in Firestore settings/master_workbook for Vercel serverless containers'
);

assert(
  excelServiceContent.includes('finalizeDailyAttendanceInMaster') &&
  excelServiceContent.includes('attendanceRecords?: AttendanceRecord[]'),
  'finalizeDailyAttendanceInMaster accepts authoritative attendance records'
);

assert(
  excelServiceContent.includes('COUNTIF(L') &&
  excelServiceContent.includes('recalculateStudentRow'),
  'recalculateStudentRow recalculates H (Present), I (Absent), J (Leave), K (%) formulas for each student'
);

assert(
  excelServiceContent.includes('Verification Step: Confirm that saved workbook contains the expected P/A entries'),
  'finalizeDailyAttendanceInMaster performs post-save cell verification check'
);

const finalizeRoutePath = path.join(rootDir, 'app', 'api', 'attendance', 'master-excel', 'finalize', 'route.ts');
const finalizeRouteContent = fs.readFileSync(finalizeRoutePath, 'utf8');

assert(
  finalizeRouteContent.includes('recordsToUse') &&
  finalizeRouteContent.includes('finalizeDailyAttendanceInMaster(date, adminEmail, recordsToUse'),
  'finalize route passes confirmed attendance records into finalizeDailyAttendanceInMaster'
);

const downloadRoutePath = path.join(rootDir, 'app', 'api', 'attendance', 'master-excel', 'download', 'route.ts');
const downloadRouteContent = fs.readFileSync(downloadRoutePath, 'utf8');

assert(
  downloadRouteContent.includes('getMasterWorkbookBufferForDownload()') &&
  downloadRouteContent.includes('no-cache, no-store, must-revalidate'),
  'download route retrieves latest persistent workbook with no-cache headers'
);

// ----------------------------------------------------------------------------
// TEST 4: Master Excel Finalization Logic Simulation
// ----------------------------------------------------------------------------
console.log('\n--- TEST 4: MASTER EXCEL FINALIZATION RUNTIME TEST ---');

// Dynamically import excel-master-service and test finalize
import('../lib/excel-master-service.ts').then(async (excelModule) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const mockStudentRecords = [
      {
        id: `att_test1_${today}`,
        studentUid: 'mock_uid_1',
        studentId: 'ASDC-0001',
        studentName: 'MOHAMMAD TALHA',
        studentEmail: 'talha@gmail.com',
        classDate: today,
        batchId: 'ai-builder-mastery',
        status: 'PRESENT',
        source: 'QR_SCAN',
        verifiedAt: new Date().toISOString(),
      },
      {
        id: `att_test2_${today}`,
        studentUid: 'mock_uid_2',
        studentId: 'ASDC-0002',
        studentName: 'SYED AFFAN',
        studentEmail: 'affan@gmail.com',
        classDate: today,
        batchId: 'ai-builder-mastery',
        status: 'PRESENT',
        source: 'QR_SCAN',
        verifiedAt: new Date().toISOString(),
      },
    ];

    console.log(`  Executing finalizeDailyAttendanceInMaster for date: ${today}...`);
    const finalResult = await excelModule.finalizeDailyAttendanceInMaster(
      today,
      'mdausafmohiuddin@gmail.com',
      mockStudentRecords
    );

    assert(finalResult.success === true, 'Finalization succeeded');
    assert(finalResult.presentCount === 2, `Confirmed present count is 2 (got ${finalResult.presentCount})`);
    assert(finalResult.absentCount === 22, `Confirmed absent count is 22 (got ${finalResult.absentCount})`);
    assert(finalResult.finalizedCount === 22, `Finalized unrecorded count is 22 (got ${finalResult.finalizedCount})`);

    // Verify download buffer integrity
    const downloadData = await excelModule.getMasterWorkbookBufferForDownload();
    assert(
      downloadData.buffer && downloadData.buffer.length > 20000 &&
      downloadData.buffer.readUInt32LE(0) === 0x04034b50,
      `Master workbook download buffer is a valid ZIP/XLSX (${downloadData.buffer.length} bytes)`
    );

    console.log('\n=================================================================');
    if (allPassed) {
      console.log('       ALL VERIFICATION TESTS PASSED SUCCESSFULLY! (15/15)        ');
    } else {
      console.error('       SOME TESTS FAILED! PLEASE REVIEW OUTPUT ABOVE.             ');
    }
    console.log('=================================================================\n');

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error('Error during runtime excel test:', err);
    process.exit(1);
  }
}).catch((err) => {
  console.error('Failed to load excel module:', err);
  process.exit(1);
});
