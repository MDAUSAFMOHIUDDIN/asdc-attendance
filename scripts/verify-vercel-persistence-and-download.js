/**
 * ASDC Attendance - Verification of Vercel Production Excel Fix:
 * 1. Read-only deployment protection (never writes to /var/task or bundled app directory)
 * 2. Temporary writable workspace in os.tmpdir() (/tmp)
 * 3. Actual attendance update
 * 4. Persistence verification across a complete server restart (wiped /tmp directory & fresh process)
 * 5. Download functionality verification retrieving latest updated master workbook with history
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

async function runTest() {
  console.log('========================================================================');
  console.log('  VERIFYING VERCEL PRODUCTION FIX: PERSISTENCE, RESTART & DOWNLOAD');
  console.log('========================================================================\n');

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

  const TMP_BASE_DIR = path.join(os.tmpdir(), 'asdc-excel-master');
  const TMP_MASTER_XLSX = path.join(TMP_BASE_DIR, 'master-attendance.xlsx');
  const TMP_UNPACKED_DIR = path.join(TMP_BASE_DIR, 'unpacked');

  const {
    ensureMasterWorkbook,
    getMasterWorkbookInfo,
    getMasterAttendanceForDate,
    recordStudentAttendanceInMaster,
    getMasterWorkbookBufferForDownload,
    extractZipBuffer,
    LOCAL_PERSISTENT_DIR,
  } = require('../lib/excel-master-service.ts');

  // STEP 1: INITIAL STATE & DIRECTORY VERIFICATION
  console.log('[Step 1] Initializing master workbook and verifying working directories...');
  await ensureMasterWorkbook();

  assert(fs.existsSync(TMP_MASTER_XLSX), 'Working workbook is in os.tmpdir() (/tmp)', TMP_MASTER_XLSX);
  assert(fs.existsSync(path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml')), 'Unpacked files reside inside os.tmpdir()');

  // Verify that data/master-unpacked is NOT being written to
  const oldUnpacked = path.join(__dirname, '..', 'data', 'master-unpacked', 'xl', 'worksheets', 'sheet1.xml');
  const oldUnpackedStatBefore = fs.existsSync(oldUnpacked) ? fs.statSync(oldUnpacked).mtimeMs : 0;

  // STEP 2: ACTUAL ATTENDANCE UPDATE
  console.log('\n[Step 2] Performing actual attendance update for date 2026-11-11...');
  const testStudent = {
    studentId: 'ASDC-0001',
    fullName: 'Mohd Ahmed',
    email: 'mohd.ahmed@student.asdc.in',
  };
  const testDate = '2026-11-11';

  const updateResult = await recordStudentAttendanceInMaster(testStudent, testDate, 'P');
  assert(updateResult.success === true, 'Attendance update succeeded');
  assert(updateResult.row === 7, `Mohd Ahmed mapped to row 7 (found ${updateResult.row})`);
  assert(typeof updateResult.column === 'string' && updateResult.column.length > 0, `Mapped to date column: ${updateResult.column}`);

  // Verify the bundled file in data/master-unpacked was untouched
  const oldUnpackedStatAfter = fs.existsSync(oldUnpacked) ? fs.statSync(oldUnpacked).mtimeMs : 0;
  assert(oldUnpackedStatBefore === oldUnpackedStatAfter, 'Deployment directory (/var/task/data/master-unpacked) was NEVER touched or modified');

  // Verify attendance record in current session
  const verifyCurrent = await getMasterAttendanceForDate(testDate);
  const studentRecord = verifyCurrent.records.find((r) => r.row === 7);
  assert(studentRecord && studentRecord.status === 'P', 'Attendance for Mohd Ahmed on 2026-11-11 is marked "P"');

  // STEP 3: SIMULATING SERVER RESTART (COLD START)
  console.log('\n[Step 3] Simulating server restart (Cold start with wiped /tmp directory)...');
  console.log('  -> Wiping os.tmpdir() working directory...');
  fs.rmSync(TMP_BASE_DIR, { recursive: true, force: true });
  assert(!fs.existsSync(TMP_MASTER_XLSX), 'Temp directory completely wiped (simulating new container / server restart)');

  // In a real server restart, a fresh Node process starts with empty /tmp.
  // We now run a separate Node sub-process to test cold start from persistent storage!
  const scriptToRunInFreshProcess = `
    const { getMasterWorkbookInfo, getMasterAttendanceForDate, getMasterWorkbookBufferForDownload, extractZipBuffer } = require('./lib/excel-master-service.ts');
    async function check() {
      const info = await getMasterWorkbookInfo();
      const att = await getMasterAttendanceForDate('2026-11-11');
      const rec = att.records.find(r => r.row === 7);
      const download = await getMasterWorkbookBufferForDownload();
      
      const res = {
        totalStudents: info.totalStudents,
        version: info.version,
        markedStatus: rec ? rec.status : null,
        downloadSize: download.buffer.length,
        downloadFilename: download.filename
      };
      console.log(JSON.stringify(res));
    }
    check().catch(err => { console.error(err); process.exit(1); });
  `;

  console.log('  -> Launching fresh Node.js server process to verify cold-start persistence...');
  const appDir = path.join(__dirname, '..');
  const freshOutput = execSync(
    `node -e "${scriptToRunInFreshProcess.replace(/\n/g, ' ')}"`,
    {
      cwd: appDir,
      env: { ...process.env, NODE_PATH: path.join(appDir, 'node_modules') },
      encoding: 'utf8',
    }
  );

  const cleanJsonMatch = freshOutput.match(/\{"totalStudents":[\s\S]*\}/);
  if (!cleanJsonMatch) {
    throw new Error(`Unexpected output from fresh process: ${freshOutput}`);
  }
  const restartResult = JSON.parse(cleanJsonMatch[0]);

  assert(restartResult.totalStudents === 24, `Fresh process loaded all 24 students (found ${restartResult.totalStudents})`);
  assert(restartResult.markedStatus === 'P', 'PERSISTENCE CONFIRMED: Mohd Ahmed is still marked "P" for 2026-11-11 after restart!');
  assert(restartResult.version >= 2, `Metadata version preserved across restart (version ${restartResult.version})`);

  // STEP 4: VERIFYING DOWNLOAD FUNCTIONALITY
  console.log('\n[Step 4] Verifying master Excel download from persistent storage...');
  assert(restartResult.downloadSize > 200000, `Downloaded workbook has valid size (${restartResult.downloadSize} bytes)`);
  assert(restartResult.downloadFilename === 'B-19-AI Builder (1) (3).xlsx', `Canonical filename preserved: ${restartResult.downloadFilename}`);

  // Inspect downloaded buffer binary
  const { buffer: dlBuffer } = await getMasterWorkbookBufferForDownload();
  const inspectDir = path.join(os.tmpdir(), 'asdc-download-inspect-' + Date.now());
  fs.mkdirSync(inspectDir, { recursive: true });
  extractZipBuffer(dlBuffer, inspectDir);

  const downloadedSheet1 = fs.readFileSync(path.join(inspectDir, 'xl', 'worksheets', 'sheet1.xml'), 'utf8');
  assert(downloadedSheet1.includes('r="AB7"') || downloadedSheet1.includes('r="AC7"'), 'Downloaded workbook contains cell record for student Mohd Ahmed');

  // Check that row 7 Present count formula exists in downloaded workbook
  assert(downloadedSheet1.includes('<f>COUNTIF(L7:DP7,"p")</f>'), 'Downloaded workbook preserves formula: COUNTIF(L7:DP7,"p")');
  assert(downloadedSheet1.includes('<f>H7/G7</f>'), 'Downloaded workbook preserves percentage formula: H7/G7');

  // Clean up inspectDir
  fs.rmSync(inspectDir, { recursive: true, force: true });

  console.log('\n========================================================================');
  console.log(`  RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runTest().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
