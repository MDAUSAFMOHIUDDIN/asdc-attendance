/**
 * ASDC Attendance - Comprehensive Master Excel Integration Verification Suite
 */

const fs = require('fs');
const path = require('path');

// We use agy-node to execute this test
async function runTests() {
  console.log('===============================================================');
  console.log('  ASDC ATTENDANCE: MASTER EXCEL INTEGRATION TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName}`);
      failed++;
    }
  }

  const {
    ensureMasterWorkbook,
    getMasterWorkbookInfo,
    getMasterAttendanceForDate,
    recordStudentAttendanceInMaster,
    finalizeDailyAttendanceInMaster,
    correctAttendanceEntryInMaster,
    getMasterWorkbookFilePath,
    colNameToIndex,
    indexToColName,
  } = require('../lib/excel-master-service.ts');

  const { SOLE_ADMIN_EMAIL, isAuthorizedAdmin } = require('../lib/admin-config.ts');

  try {
    // TEST 1: Initial Import & Metadata
    console.log('[Test 1] Verifying canonical master initialization...');
    await ensureMasterWorkbook();
    const info = await getMasterWorkbookInfo();
    assert(info.workbookName === 'B-19-AI Builder (1) (3).xlsx', 'Workbook name is canonical B-19-AI Builder (1) (3).xlsx');
    assert(info.worksheetName === 'B-19-AI Builder', 'Worksheet name is B-19-AI Builder');
    assert(info.totalStudents === 24, `Total students in official roster is exactly 24 (found ${info.totalStudents})`);
    assert(info.startDate === '2026-10-19', `Start date is 2026-10-19 (found ${info.startDate})`);
    assert(info.availableDates.length >= 80, `Available date columns >= 80 (found ${info.availableDates.length})`);

    // TEST 2: Student Information & Formula Preservation
    console.log('\n[Test 2] Verifying student information & formulas...');
    const student1 = info.students[0];
    const student24 = info.students[23];
    assert(student1.row === 7 && student1.name === 'Mohd Ahmed', `Row 7 is Mohd Ahmed (found: ${student1.name})`);
    assert(student24.row === 30 && student24.name === 'obaid khan', `Row 30 is obaid khan (found: ${student24.name})`);
    assert(student1.total === 90, 'Total classes formula evaluated to 90');
    assert(typeof student1.percentage === 'number' && student1.percentage > 0, `Percentage is calculated (${(student1.percentage * 100).toFixed(1)}%)`);

    // TEST 3: Existing Historical Attendance Preservation
    console.log('\n[Test 3] Verifying existing attendance history preservation...');
    const histDate1 = '2026-10-20';
    const hist1 = await getMasterAttendanceForDate(histDate1);
    assert(hist1.column === 'M', `2026-10-20 maps to column M (found ${hist1.column})`);
    assert(hist1.records[0].status === 'A', `Mohd Ahmed on 2026-10-20 is historical Absent 'A' (found ${hist1.records[0].status})`);

    const histDate2 = '2026-10-22';
    const hist2 = await getMasterAttendanceForDate(histDate2);
    assert(hist2.column === 'O', `2026-10-22 maps to column O (found ${hist2.column})`);
    assert(hist2.records[0].status === 'P', `Mohd Ahmed on 2026-10-22 is historical Present 'P' (found ${hist2.records[0].status})`);

    // TEST 4: Date-based attendance mapping (Today: 2026-11-04 -> Column AB)
    console.log('\n[Test 4] Verifying date-based attendance mapping (2026-11-04)...');
    const todayTarget = '2026-11-04';
    const recResult = await recordStudentAttendanceInMaster(
      { studentId: 'ASDC-0004', fullName: 'Md Faisal', email: 'faisal@example.com' },
      todayTarget,
      'P'
    );
    assert(recResult.success === true, 'Attendance record succeeded');
    assert(recResult.column === 'AB', `2026-11-04 mapped to exact column AB (found ${recResult.column})`);
    assert(recResult.row === 10, `Md Faisal mapped to row 10 (found ${recResult.row})`);

    // TEST 5: Duplicate Prevention
    console.log('\n[Test 5] Verifying duplicate prevention...');
    const dupResult = await recordStudentAttendanceInMaster(
      { studentId: 'ASDC-0004', fullName: 'Md Faisal', email: 'faisal@example.com' },
      todayTarget,
      'P'
    );
    assert(dupResult.alreadyRecorded === true, 'Duplicate scan recognized and prevented');

    // TEST 6: Previous and Future Date Updates
    console.log('\n[Test 6] Verifying previous date updates...');
    const prevDate = '2026-10-23'; // Column P
    const prevResult = await recordStudentAttendanceInMaster(
      { studentId: 'ASDC-0005', fullName: 'Syed Ayhaan Uddin', email: 'ayhaan@example.com' },
      prevDate,
      'P'
    );
    assert(prevResult.column === 'P', `Previous date 2026-10-23 mapped to column P (found ${prevResult.column})`);

    // TEST 7: Concurrent Scan Safety (Mutex / Lock Test)
    console.log('\n[Test 7] Verifying concurrent attendance submissions...');
    const concurrentStudents = [
      { studentId: 'ASDC-0006', fullName: 'Syed Muqeem Mohiuddin', email: 'muqeem@example.com' },
      { studentId: 'ASDC-0007', fullName: 'Shaik Nawaz', email: 'nawaz@example.com' },
      { studentId: 'ASDC-0008', fullName: 'Syed Kareem Ullah Hussaini', email: 'kareem@example.com' },
      { studentId: 'ASDC-0009', fullName: 'Mohammed Farhan Hussain', email: 'farhan@example.com' },
      { studentId: 'ASDC-0010', fullName: 'Obadha Aqueel Ahmed', email: 'obadha@example.com' },
    ];
    const concurrentPromises = concurrentStudents.map(stu =>
      recordStudentAttendanceInMaster(stu, todayTarget, 'P')
    );
    const concurrentResults = await Promise.all(concurrentPromises);
    const allSuccessful = concurrentResults.every(r => r.success);
    assert(allSuccessful, '5 concurrent submissions serialized and completed without collision');

    // TEST 8: Daily Absence Finalization
    console.log('\n[Test 8] Verifying daily absence finalization...');
    const finalizeDate = '2026-11-04';
    const finalizeRes = await finalizeDailyAttendanceInMaster(finalizeDate, SOLE_ADMIN_EMAIL);
    assert(finalizeRes.success === true, 'Finalization succeeded');
    assert(finalizeRes.column === 'AB', `Finalized column is AB (found ${finalizeRes.column})`);
    assert(typeof finalizeRes.finalizedCount === 'number', `Marked ${finalizeRes.finalizedCount} unmarked students as Absent (A)`);
    assert(finalizeRes.presentCount >= 6, `Retained at least 6 present students (found ${finalizeRes.presentCount})`);

    // Verify after finalization that unmarked count is now 0
    const checkFinalized = await getMasterAttendanceForDate(finalizeDate);
    assert(checkFinalized.unmarkedCount === 0, `All students accounted for: 0 unmarked (Present: ${checkFinalized.presentCount}, Absent: ${checkFinalized.absentCount})`);

    // TEST 9: Administrative Attendance Correction with Audit Reason
    console.log('\n[Test 9] Verifying administrative attendance correction...');
    const corrRes = await correctAttendanceEntryInMaster({
      row: 7, // Mohd Ahmed
      dateStr: todayTarget,
      newStatus: 'P',
      reason: 'Verified on-site participation via manual institute log',
      adminEmail: SOLE_ADMIN_EMAIL,
    });
    assert(corrRes.success === true, 'Correction succeeded');
    assert(corrRes.cellRef === 'AB7', `Target cell is AB7 (found ${corrRes.cellRef})`);
    assert(corrRes.studentName === 'Mohd Ahmed', `Target student is Mohd Ahmed`);

    // TEST 10: Security & Authorization Check
    console.log('\n[Test 10] Verifying security & unauthorized access rejection...');
    const unauthorizedEmail = 'attacker@student.edu';
    assert(isAuthorizedAdmin(unauthorizedEmail) === false, 'Unauthorized email correctly rejected by isAuthorizedAdmin');
    assert(isAuthorizedAdmin(SOLE_ADMIN_EMAIL) === true, `${SOLE_ADMIN_EMAIL} correctly accepted as sole administrator`);

    let securityBlocked = false;
    try {
      await finalizeDailyAttendanceInMaster(todayTarget, unauthorizedEmail);
    } catch {
      securityBlocked = true;
    }
    assert(securityBlocked, 'Unauthorized user blocked from finalizeDailyAttendanceInMaster');

    // TEST 11: Master Download File Verification
    console.log('\n[Test 11] Verifying canonical master download snapshot...');
    const masterPath = getMasterWorkbookFilePath();
    assert(fs.existsSync(masterPath), `Master workbook exists at ${masterPath}`);
    const stats = fs.statSync(masterPath);
    assert(stats.size > 200000, `Master workbook size is healthy (${stats.size} bytes)`);

    console.log('\n===============================================================');
    console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('===============================================================\n');

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error('Test suite runtime error:', err);
    process.exit(1);
  }
}

runTests();
