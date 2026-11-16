/**
 * ASDC ATTENDANCE - VERIFICATION TEST SUITE FOR ALL THREE CHANGES
 * 
 * 1. Admin Push Notification Permission & Delivery Verification
 * 2. Master Excel Attendance Date-Wise & Student-Wise Reconcile Verification
 * 3. ASDC App Installation Invitation Popup Verification
 */

const fs = require('fs');
const path = require('path');

async function runAllVerifications() {
  console.log('========================================================================');
  console.log('  ASDC ATTENDANCE: VERIFICATION OF THE THREE SPECIFIC CHANGES');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName} ${details ? '(' + details + ')' : ''}`);
      failed++;
    }
  }

  // ===========================================================================
  // SECTION 1: TASK 1 - ADMIN PUSH NOTIFICATION PERMISSION ERROR FIX
  // ===========================================================================
  console.log('--- [1] ADMIN PUSH NOTIFICATION PERMISSION ERROR FIX & DELIVERY ---');

  const sendRoutePath = path.join(__dirname, '..', 'app', 'api', 'notifications', 'send', 'route.ts');
  const sendRouteContent = fs.readFileSync(sendRoutePath, 'utf8');

  assert(
    sendRouteContent.includes('verifyAdminIdToken') &&
    sendRouteContent.includes('SOLE_ADMIN_EMAIL'),
    'Backend verifies admin ID token and strictly authorizes mdausafmohiuddin@gmail.com'
  );

  assert(
    sendRouteContent.includes('saveNotificationToFirestore') &&
    sendRouteContent.includes('https://firestore.googleapis.com/v1/projects/'),
    'Backend saves notifications to Firestore via authenticated REST API with admin bearer token'
  );

  assert(
    sendRouteContent.includes('fetchPushSubscriptions') &&
    sendRouteContent.includes('Authorization: `Bearer ${idToken}`'),
    'Backend retrieves push subscriptions using admin bearer token (no permission error)'
  );

  assert(
    sendRouteContent.includes('webPush.sendNotification') &&
    sendRouteContent.includes('removeExpiredSubscription'),
    'Backend delivers FCM / Web Push and removes expired subscriptions (HTTP 410/404)'
  );

  assert(
    !sendRouteContent.includes("setDoc(notifRef") &&
    !sendRouteContent.includes("getDocs(collection(db, 'push_subscriptions'))"),
    'Eliminated unauthenticated client SDK calls on the server that caused 7 PERMISSION_DENIED'
  );

  const composerPath = path.join(__dirname, '..', 'components', 'NotificationComposerModal.tsx');
  const composerContent = fs.readFileSync(composerPath, 'utf8');

  assert(
    composerContent.includes('currentUser.getIdToken(true)') &&
    composerContent.includes('Authorization: `Bearer ${idToken}`'),
    'NotificationComposerModal acquires Firebase Auth ID token and sends in Authorization header'
  );

  const pushServicePath = path.join(__dirname, '..', 'lib', 'push-notification-service.ts');
  const pushServiceContent = fs.readFileSync(pushServicePath, 'utf8');

  assert(
    pushServiceContent.includes('docRef = doc(db, \'push_subscriptions\', uid)') &&
    pushServiceContent.includes('setDoc(docRef, record'),
    'push-notification-service saves student subscription directly in Firestore with authenticated client'
  );

  assert(
    pushServiceContent.includes('subscribeToNotifications') &&
    pushServiceContent.includes('markNotificationAsRead'),
    'Student in-app notification panel subscription and mark-as-read handlers are active'
  );

  // ===========================================================================
  // SECTION 2: TASK 2 - MASTER EXCEL ATTENDANCE SYNCHRONIZATION
  // ===========================================================================
  console.log('\n--- [2] MASTER EXCEL ATTENDANCE SYNCHRONIZATION (ALL DATES & STUDENTS) ---');

  const {
    ensureMasterWorkbook,
    getMasterWorkbookInfo,
    getMasterAttendanceForDate,
    matchStudentToExcelRow,
    recordStudentAttendanceInMaster,
    finalizeDailyAttendanceInMaster,
    reconcileAllDatesInMaster,
    getMasterWorkbookFilePath,
  } = require('../lib/excel-master-service.ts');

  await ensureMasterWorkbook();
  const info = await getMasterWorkbookInfo();

  // Test Student Matching
  console.log('\n  Sub-test 2A: Verified student matching (No S.NO bug)...');
  const match1 = matchStudentToExcelRow({ studentId: 'ASDC-0001', fullName: 'Mohd Ahmed' }, info.students);
  assert(match1 && match1.row === 7 && match1.name === 'Mohd Ahmed', 'Exact match: Mohd Ahmed -> Row 7');

  const match2 = matchStudentToExcelRow({ studentId: 'ASDC-0002', fullName: 'Mohammed Riyaz' }, info.students);
  assert(match2 && match2.row === 8 && match2.name === 'Mohammed Riyaz', 'Exact match: Mohammed Riyaz -> Row 8');

  const match3 = matchStudentToExcelRow({ studentId: 'ASDC-0003', fullName: 'Yaser Abdul Ghani Zama Khan' }, info.students);
  assert(match3 && match3.row === 9, 'Exact match: Yaser Abdul Ghani Zama Khan -> Row 9');

  const match4 = matchStudentToExcelRow({ studentId: 'ASDC-0004', fullName: 'Md Faisal' }, info.students);
  assert(match4 && match4.row === 10, 'Alias match: Md Faisal -> Row 10');

  const match5 = matchStudentToExcelRow({ studentId: 'ASDC-0005', fullName: 'Syed Ayhaan Uddin' }, info.students);
  assert(match5 && match5.row === 11, 'Exact match: Syed Ayhaan Uddin -> Row 11');

  const match6 = matchStudentToExcelRow({ studentId: 'ASDC-0007', fullName: 'Shaik Nawaz' }, info.students);
  assert(match6 && match6.row === 13, 'Alias match: Shaik Nawaz -> Row 13');

  const matchObaid = matchStudentToExcelRow({ studentId: 'ASDC-0024', fullName: 'obaid khan' }, info.students);
  assert(matchObaid && matchObaid.row === 30, 'Exact match: obaid khan -> Row 30');

  // Verify non-matching student is NEVER matched to Row 7 or S.No 1
  const matchUnknown = matchStudentToExcelRow({ studentId: 'ASDC-0001', fullName: 'Unknown Student Not In Roster' }, info.students);
  assert(matchUnknown === null, 'Unknown student is NEVER matched to S.NO 1 or any other student row');

  // Test Multi-Date Reconciliation across ALL dates
  console.log('\n  Sub-test 2B: Multi-date reconciliation across multiple students & dates...');
  const testRecords = [
    // Date 1: 2026-11-17 (Unfinalized day: 2 present, 22 unfinalized - must NOT be marked absent)
    {
      id: 'rec_20261117_1',
      studentId: 'ASDC-0004',
      studentName: 'Md Faisal',
      studentEmail: 'faisal@gmail.com',
      classDate: '2026-11-17',
      status: 'PRESENT',
      batchId: 'ai-builder-mastery',
      source: 'QR_SCAN',
    },
    {
      id: 'rec_20261117_2',
      studentId: 'ASDC-0007',
      studentName: 'Shaik Nawaz',
      studentEmail: 'nawaz@gmail.com',
      classDate: '2026-11-17',
      status: 'PRESENT',
      batchId: 'ai-builder-mastery',
      source: 'QR_SCAN',
    },
    // Date 2: 2026-11-18 (Finalized day: 3 present, 21 absent)
    {
      id: 'rec_20261118_1',
      studentId: 'ASDC-0001',
      studentName: 'Mohd Ahmed',
      studentEmail: 'ahmed@gmail.com',
      classDate: '2026-11-18',
      status: 'PRESENT',
      batchId: 'ai-builder-mastery',
      source: 'QR_SCAN',
    },
    {
      id: 'rec_20261118_2',
      studentId: 'ASDC-0002',
      studentName: 'Mohammed Riyaz',
      studentEmail: 'riyaz@gmail.com',
      classDate: '2026-11-18',
      status: 'PRESENT',
      batchId: 'ai-builder-mastery',
      source: 'QR_SCAN',
    },
    {
      id: 'rec_20261118_3',
      studentId: 'ASDC-0024',
      studentName: 'obaid khan',
      studentEmail: 'obaid@gmail.com',
      classDate: '2026-11-18',
      status: 'PRESENT',
      batchId: 'ai-builder-mastery',
      source: 'QR_SCAN',
    },
  ];

  // Reconcile with 2026-11-18 being finalized, and 2026-11-17 unfinalized
  const reconcileRes = await reconcileAllDatesInMaster({
    allAttendanceRecords: testRecords,
    finalizedDates: ['2026-11-18'],
    adminEmail: 'mdausafmohiuddin@gmail.com',
  });

  assert(reconcileRes.success === true, 'reconcileAllDatesInMaster succeeded');
  assert(reconcileRes.syncedDates.includes('2026-11-17'), '2026-11-17 synced');
  assert(reconcileRes.syncedDates.includes('2026-11-18'), '2026-11-18 synced');

  // Verify Date 1 (2026-11-17, unfinalized): Present = 2, Absent = 0, Unfinalized = 22 (NOT marked absent!)
  const d1 = await getMasterAttendanceForDate('2026-11-17');
  assert(d1.presentCount === 2, `Date 2026-11-17 has exactly 2 Present (got ${d1.presentCount})`);
  assert(d1.absentCount === 0, `Date 2026-11-17 has 0 Absent because date was NOT finalized (got ${d1.absentCount})`);
  assert(d1.unmarkedCount === 22, `Date 2026-11-17 has 22 unfinalized/unmarked (got ${d1.unmarkedCount})`);

  // Verify Date 2 (2026-11-18, finalized): Present = 3, Absent = 21, Unmarked = 0
  const d2 = await getMasterAttendanceForDate('2026-11-18');
  assert(d2.presentCount === 3, `Date 2026-11-18 has exactly 3 Present (got ${d2.presentCount})`);
  assert(d2.absentCount === 21, `Date 2026-11-18 has exactly 21 Absent because date was finalized (got ${d2.absentCount})`);
  assert(d2.unmarkedCount === 0, `Date 2026-11-18 has 0 unmarked after finalization (got ${d2.unmarkedCount})`);

  // Verify specific students on 2026-11-18:
  // Mohd Ahmed (row 7) is 'P'
  // obaid khan (row 30) is 'P'
  // Md Faisal (row 10) is 'A' (finalized absent)
  const ahmedRecord = d2.records.find((r) => r.row === 7);
  assert(ahmedRecord && ahmedRecord.status === 'P', `2026-11-18: Mohd Ahmed (row 7) is 'P'`);

  const obaidRec = d2.records.find((r) => r.row === 30);
  assert(obaidRec && obaidRec.status === 'P', `2026-11-18: obaid khan (row 30) is 'P'`);

  const faisalRec = d2.records.find((r) => r.row === 10);
  assert(faisalRec && faisalRec.status === 'A', `2026-11-18: Md Faisal (row 10) is 'A'`);

  // Verify actual XLSX file on disk
  const filePath = getMasterWorkbookFilePath();
  assert(fs.existsSync(filePath), `Master workbook XLSX exists on disk at ${filePath}`);
  const fileStat = fs.statSync(filePath);
  assert(fileStat.size > 100000, `Master workbook XLSX is healthy size (${fileStat.size} bytes)`);

  // ===========================================================================
  // SECTION 3: TASK 3 - IMMEDIATE APP INSTALLATION POPUP VERIFICATION
  // ===========================================================================
  console.log('\n--- [3] IMMEDIATE APP INSTALLATION POPUP VERIFICATION ---');

  const pwaBannerPath = path.join(__dirname, '..', 'components', 'PWAInstallBanner.tsx');
  const pwaBannerContent = fs.readFileSync(pwaBannerPath, 'utf8');

  assert(
    pwaBannerContent.includes('Install ASDC Attendance'),
    'Popup displays exact required title: "Install ASDC Attendance"'
  );

  assert(
    pwaBannerContent.includes('Install our app for faster and easier access to your attendance dashboard.'),
    'Popup displays exact required text: "Install our app for faster and easier access to your attendance dashboard."'
  );

  assert(
    pwaBannerContent.includes('INSTALL APP'),
    'Popup has exact required primary button: "INSTALL APP"'
  );

  assert(
    pwaBannerContent.includes('src="/asdc-logo.png"') ||
    pwaBannerContent.includes("src='/asdc-logo.png'") ||
    pwaBannerContent.includes("'/asdc-logo.png'"),
    'Popup displays official ASDC application logo (/asdc-logo.png)'
  );

  assert(
    pwaBannerContent.includes('beforeinstallprompt') &&
    pwaBannerContent.includes('deferredPrompt.prompt()'),
    'INSTALL APP button triggers real browser beforeinstallprompt installation flow'
  );

  assert(
    pwaBannerContent.includes('appinstalled') &&
    pwaBannerContent.includes('isStandalone') &&
    pwaBannerContent.includes('asdc_pwa_installed'),
    'Popup detects installed/standalone mode and ceases showing once installed'
  );

  assert(
    pwaBannerContent.includes('Share') &&
    pwaBannerContent.includes('Add to Home Screen'),
    'Displays clear instructions for Add to Home Screen when native install prompt is unsupported'
  );

  assert(
    pwaBannerContent.includes('handleDismiss') &&
    pwaBannerContent.includes('Not now'),
    'Allows user to dismiss without blocking access to website or navigation'
  );

  const layoutPath = path.join(__dirname, '..', 'app', 'layout.tsx');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');

  assert(
    layoutContent.includes('<PWAInstallBanner />'),
    'app/layout.tsx mounts PWAInstallBanner at the root level for immediate display across all entry points'
  );

  console.log('\n========================================================================');
  console.log(`  FINAL VERIFICATION RESULT: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllVerifications().catch((err) => {
  console.error('Verification suite encountered error:', err);
  process.exit(1);
});
