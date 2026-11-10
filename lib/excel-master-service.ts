/**
 * ASDC Attendance - Canonical Master Excel Workbook Service
 * 
 * Official Register: B-19-AI Builder (1) (3).xlsx
 * Sheet: 'B-19-AI Builder'
 * Batch: 'BATCH-19'
 * 
 * Manages the single persistent master Excel workbook with:
 * - Direct OpenXML preservation (layout, styles, formulas, merged cells, history)
 * - Date-based column mapping (IST Asia/Kolkata)
 * - Safe concurrency serialization via AsyncLock
 * - Atomic file writes and version tracking
 * - Daily absence finalization (marking unrecorded students 'A')
 * - Administrative corrections with mandatory audit reasoning
 */

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import AsyncLock from 'async-lock';
import { SOLE_ADMIN_EMAIL, isAuthorizedAdmin } from './admin-config.ts';

const lock = new AsyncLock();

// Directory & File Paths
const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const MASTER_XLSX_PATH = path.join(DATA_DIR, 'master-attendance.xlsx');
const INITIAL_BACKUP_PATH = path.join(BACKUP_DIR, 'B-19-AI Builder (1) (3).initial-backup.xlsx');
const UNPACKED_DIR = path.join(DATA_DIR, 'master-unpacked');
const META_FILE_PATH = path.join(DATA_DIR, 'master-meta.json');

// Source workbook location in Downloads as designated by the user
const SOURCE_DOWNLOAD_PATH = 'C:\\Users\\Students\\Downloads\\B-19-AI Builder (1) (3).xlsx';

// Excel OpenXML Base Epoch (1899-12-30 for 1900 date system leap year compatibility)
const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30));

// Shared String IDs in the canonical workbook
// 13: "P" (Present)
// 14: "A" (Absent)
// 15: "L" (Leave / Excused)
export const SHARED_STRING_PRESENT = 13;
export const SHARED_STRING_ABSENT = 14;
export const SHARED_STRING_LEAVE = 15;

export interface ExcelStudentRow {
  row: number;
  sno: string;
  admissionNo: string;
  name: string;
  course: string;
  status: string;
  timing: string;
  total: number;
  present: number;
  absent: number;
  leave: number;
  percentage: number;
}

export interface MasterWorkbookInfo {
  workbookName: string;
  batchName: string;
  worksheetName: string;
  lastSyncedAt: string;
  version: number;
  startDate: string;
  endDate: string;
  totalStudents: number;
  availableDates: string[];
  students: ExcelStudentRow[];
  syncStatus: 'HEALTHY' | 'SYNCED' | 'ERROR';
  errors: string[];
}

export interface DateAttendanceRecord {
  row: number;
  sno: string;
  admissionNo: string;
  name: string;
  status: 'P' | 'A' | 'L' | null;
  cellRef: string;
}

export interface MasterMeta {
  workbookName: string;
  batchName: string;
  worksheetName: string;
  version: number;
  lastSyncedAt: string;
  errors: string[];
  studentMappings: Record<string, number>; // studentId -> row number
}

/**
 * Utility: Convert column letter to 1-based index (e.g., 'A' -> 1, 'L' -> 12, 'AB' -> 28)
 */
export function colNameToIndex(col: string): number {
  let index = 0;
  for (let i = 0; i < col.length; i++) {
    index = index * 26 + (col.charCodeAt(i) - 64);
  }
  return index;
}

/**
 * Utility: Convert 1-based index to column letter (e.g., 1 -> 'A', 12 -> 'L', 28 -> 'AB')
 */
export function indexToColName(index: number): string {
  let col = '';
  while (index > 0) {
    const rem = (index - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    index = Math.floor((index - 1) / 26);
  }
  return col;
}

/**
 * Utility: Convert YYYY-MM-DD date to Excel Serial number
 */
export function dateToSerial(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Math.round((dt.getTime() - EXCEL_EPOCH.getTime()) / 86400000);
}

/**
 * Utility: Convert Excel Serial number to YYYY-MM-DD
 */
export function serialToDate(serial: number): string {
  const dt = new Date(EXCEL_EPOCH.getTime() + serial * 86400000);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Read Master Metadata
 */
function readMeta(): MasterMeta {
  if (fs.existsSync(META_FILE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(META_FILE_PATH, 'utf8'));
    } catch {
      // Fallback
    }
  }
  const defaultMeta: MasterMeta = {
    workbookName: 'B-19-AI Builder (1) (3).xlsx',
    batchName: 'BATCH-19 (AI Builder)',
    worksheetName: 'B-19-AI Builder',
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    errors: [],
    studentMappings: {},
  };
  fs.writeFileSync(META_FILE_PATH, JSON.stringify(defaultMeta, null, 2), 'utf8');
  return defaultMeta;
}

/**
 * Save Master Metadata
 */
function saveMeta(meta: MasterMeta) {
  fs.writeFileSync(META_FILE_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

/**
 * Initialize Master Workbook environment and backup
 */
export async function ensureMasterWorkbook(): Promise<void> {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch {
    // In read-only serverless environment, ignore mkdir errors
  }

  // If master-attendance.xlsx does not exist, restore from backup or source
  if (!fs.existsSync(MASTER_XLSX_PATH)) {
    if (fs.existsSync(INITIAL_BACKUP_PATH)) {
      try {
        fs.copyFileSync(INITIAL_BACKUP_PATH, MASTER_XLSX_PATH);
      } catch {
        // read-only fs
      }
    } else if (fs.existsSync(SOURCE_DOWNLOAD_PATH)) {
      try {
        fs.copyFileSync(SOURCE_DOWNLOAD_PATH, MASTER_XLSX_PATH);
      } catch {
        // read-only fs
      }
    }
  }

  // Ensure initial backup exists
  if (!fs.existsSync(INITIAL_BACKUP_PATH) && fs.existsSync(MASTER_XLSX_PATH)) {
    try {
      fs.copyFileSync(MASTER_XLSX_PATH, INITIAL_BACKUP_PATH);
    } catch {
      // read-only fs
    }
  }

  // Ensure unpacked directory exists
  const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
  if (!fs.existsSync(sheet1Path) && fs.existsSync(MASTER_XLSX_PATH)) {
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        execSync(
          `powershell -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${MASTER_XLSX_PATH}', '${UNPACKED_DIR}')"`,
          { stdio: 'ignore' }
        );
      } else {
        // Linux / serverless environment
        execSync(`unzip -q -o "${MASTER_XLSX_PATH}" -d "${UNPACKED_DIR}"`, { stdio: 'ignore' });
      }
    } catch (extractErr) {
      console.warn('[Excel Master] Note during initial extraction:', extractErr);
    }
  }

  readMeta();
}

/**
 * Rebuild master-attendance.xlsx from UNPACKED_DIR atomically
 */
async function rebuildMasterXlsx(): Promise<void> {
  const tmpOut = path.join(DATA_DIR, `master-attendance.${Date.now()}.tmp`);
  const output = fs.createWriteStream(tmpOut);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', (err: unknown) => reject(err));
    archive.pipe(output);
    archive.directory(UNPACKED_DIR, false);
    archive.finalize();
  });

  // Atomic file replace
  if (fs.existsSync(MASTER_XLSX_PATH)) {
    fs.unlinkSync(MASTER_XLSX_PATH);
  }
  fs.renameSync(tmpOut, MASTER_XLSX_PATH);

  // Update metadata
  const meta = readMeta();
  meta.version += 1;
  meta.lastSyncedAt = new Date().toISOString();
  saveMeta(meta);
}

/**
 * Load Shared Strings
 */
function loadSharedStrings(): string[] {
  const ssPath = path.join(UNPACKED_DIR, 'xl', 'sharedStrings.xml');
  if (!fs.existsSync(ssPath)) return [];
  const xml = fs.readFileSync(ssPath, 'utf8');
  const strings: string[] = [];
  const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = siRegex.exec(xml)) !== null) {
    const siContent = match[1];
    const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tMatch;
    let text = '';
    while ((tMatch = tRegex.exec(siContent)) !== null) {
      text += tMatch[1];
    }
    strings.push(text);
  }
  return strings;
}

/**
 * Parse Date Columns from Row 4 of sheet1.xml
 */
function parseDateColumns(sheetXml: string): {
  colDateMap: Record<string, string>; // Col -> YYYY-MM-DD
  dateColMap: Record<string, string>; // YYYY-MM-DD -> Col
  weekdays: Record<string, string>;   // Col -> 'Mon', 'Tue'
  lastCol: string;
} {
  const r4Match = sheetXml.match(/<row\b[^>]*r="4"[^>]*>([\s\S]*?)<\/row>/);
  const r5Match = sheetXml.match(/<row\b[^>]*r="5"[^>]*>([\s\S]*?)<\/row>/);

  const colDateMap: Record<string, string> = {};
  const dateColMap: Record<string, string> = {};
  const weekdays: Record<string, string> = {};
  let lastCol = 'L';

  if (r4Match) {
    const cellRegex = /<c\b[^>]*r="([A-Z]+)4"[^>]*>([\s\S]*?)<\/c>/g;
    let m;
    while ((m = cellRegex.exec(r4Match[1])) !== null) {
      const col = m[1];
      const inner = m[2];
      const vMatch = inner.match(/<v>(\d+)<\/v>/);
      if (vMatch) {
        const serial = Number(vMatch[1]);
        if (serial > 40000) {
          const dtStr = serialToDate(serial);
          colDateMap[col] = dtStr;
          dateColMap[dtStr] = col;
          lastCol = col;
        }
      }
    }
  }

  if (r5Match) {
    const cellRegex = /<c\b[^>]*r="([A-Z]+)5"[^>]*>([\s\S]*?)<\/c>/g;
    let m;
    while ((m = cellRegex.exec(r5Match[1])) !== null) {
      const col = m[1];
      const inner = m[2];
      const vMatch = inner.match(/<v>([^<]+)<\/v>/);
      if (vMatch) {
        weekdays[col] = vMatch[1];
      }
    }
  }

  return { colDateMap, dateColMap, weekdays, lastCol };
}

/**
 * Parse the 24 Student Rows from sheet1.xml
 */
function parseStudents(sheetXml: string, sharedStrings: string[]): ExcelStudentRow[] {
  const students: ExcelStudentRow[] = [];
  const rowRegex = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rMatch;

  while ((rMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowNum = Number(rMatch[1]);
    if (rowNum < 7 || rowNum > 30) continue; // Batch-19 student rows are 7 to 30

    const rowContent = rMatch[2];
    const cellMap: Record<string, { val: string; isString: boolean }> = {};

    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cMatch;
    while ((cMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cMatch[1];
      const body = cMatch[2] || '';
      const rMatch = attrs.match(/r="([A-Z]+)\d+"/);
      if (!rMatch) continue;
      const col = rMatch[1];
      const vMatch = body.match(/<v>([^<]*)<\/v>/);
      const v = vMatch ? vMatch[1] : '';
      const isString = /t="s"/.test(attrs);
      cellMap[col] = { val: v, isString };
    }

    const getCellText = (col: string) => {
      const c = cellMap[col];
      if (!c || c.val === '') return '';
      if (c.isString) {
        const idx = Number(c.val);
        return sharedStrings[idx] ?? '';
      }
      return c.val;
    };

    const name = getCellText('C').trim();
    if (!name) continue;

    students.push({
      row: rowNum,
      sno: getCellText('A') || String(rowNum - 6),
      admissionNo: getCellText('B'),
      name,
      course: getCellText('D') || 'AI Builder Course',
      status: getCellText('E') || 'Training',
      timing: getCellText('F') || 'Evening (5pm to 9pm)',
      total: Number(getCellText('G')) || 90,
      present: Number(getCellText('H')) || 0,
      absent: Number(getCellText('I')) || 0,
      leave: Number(getCellText('J')) || 0,
      percentage: Number(getCellText('K')) || 0,
    });
  }

  return students;
}

/**
 * Match an application student to their row in the Master Excel Workbook
 * Hierarchy:
 * 1. Explicit admin mapping in master-meta.json
 * 2. Admission ID / studentId match against S.NO or admissionNo column
 * 3. Normalized full name exact match
 * 4. Token-based full name match (handles spacing, case, 'Mohd'/'Mohammed')
 */
export function matchStudentToExcelRow(
  student: { studentId?: string; fullName?: string; email?: string },
  studentsInWorkbook: ExcelStudentRow[]
): ExcelStudentRow | null {
  const meta = readMeta();

  // 1. Check explicit mapping
  if (student.studentId && meta.studentMappings[student.studentId]) {
    const row = meta.studentMappings[student.studentId];
    const found = studentsInWorkbook.find((s) => s.row === row);
    if (found) return found;
  }

  // 2. Check S.NO / admission number match (e.g. ASDC-0001 -> 1)
  if (student.studentId) {
    const cleanId = student.studentId.trim();
    const numMatch = cleanId.match(/(\d+)$/);
    if (numMatch) {
      const numVal = parseInt(numMatch[1], 10);
      const bySno = studentsInWorkbook.find(
        (s) => parseInt(s.sno, 10) === numVal || s.admissionNo.toLowerCase() === cleanId.toLowerCase()
      );
      if (bySno) return bySno;
    }
  }

  // 3. Normalized Full Name Match
  if (!student.fullName) return null;

  const normalize = (str: string) => {
    return str
      .toLowerCase()
      .replace(/[\.\,\_\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const normInput = normalize(student.fullName);

  // Exact normalized match
  for (const s of studentsInWorkbook) {
    if (normalize(s.name) === normInput) return s;
  }

  // Aliases for common prefix variations
  const expandAliases = (name: string) => {
    return name
      .replace(/^mohd\b/i, 'mohammed')
      .replace(/^md\b/i, 'mohammed')
      .replace(/^shaik\b/i, 'shaikh');
  };

  const expandedInput = expandAliases(normInput);
  for (const s of studentsInWorkbook) {
    if (expandAliases(normalize(s.name)) === expandedInput) return s;
  }

  // Token-level subset match
  const inputTokens = new Set(normInput.split(' '));
  let bestMatch: ExcelStudentRow | null = null;
  let maxMatches = 0;

  for (const s of studentsInWorkbook) {
    const sTokens = normalize(s.name).split(' ');
    let matches = 0;
    for (const t of sTokens) {
      if (inputTokens.has(t) && t.length > 2) matches++;
    }
    if (matches > maxMatches && matches >= Math.min(2, sTokens.length)) {
      maxMatches = matches;
      bestMatch = s;
    }
  }

  return bestMatch;
}

/**
 * Ensure a specific date column exists in sheet1.xml (Row 4).
 * If the date is not in the existing columns, safely extends the headers.
 */
function ensureDateColumn(
  sheetXml: string,
  dateStr: string,
  dateInfo: { colDateMap: Record<string, string>; dateColMap: Record<string, string>; lastCol: string }
): { updatedSheetXml: string; colName: string } {
  if (dateInfo.dateColMap[dateStr]) {
    return { updatedSheetXml: sheetXml, colName: dateInfo.dateColMap[dateStr] };
  }

  // Need to append a new date column
  const lastColIndex = colNameToIndex(dateInfo.lastCol);
  const newColIndex = lastColIndex + 1;
  const newColName = indexToColName(newColIndex);
  const serial = dateToSerial(dateStr);

  const dt = new Date(Date.UTC(
    Number(dateStr.split('-')[0]),
    Number(dateStr.split('-')[1]) - 1,
    Number(dateStr.split('-')[2])
  ));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayShort = dayNames[dt.getUTCDay()];

  // 1. Insert cell in Row 4
  const r4Regex = /(<row\b[^>]*r="4"[^>]*>)([\s\S]*?)(<\/row>)/;
  sheetXml = sheetXml.replace(r4Regex, (_, start, content, end) => {
    const newCell = `<c r="${newColName}4" s="14"><v>${serial}</v></c>`;
    return `${start}${content}${newCell}${end}`;
  });

  // 2. Insert cell in Row 5
  const r5Regex = /(<row\b[^>]*r="5"[^>]*>)([\s\S]*?)(<\/row>)/;
  sheetXml = sheetXml.replace(r5Regex, (_, start, content, end) => {
    const newCell = `<c r="${newColName}5" s="32" t="str"><f>TEXT(${newColName}4,"DDD")</f><v>${dayShort}</v></c>`;
    return `${start}${content}${newCell}${end}`;
  });

  // 3. Insert empty cells for student rows 7 to 30
  for (let r = 7; r <= 30; r++) {
    const rowRegex = new RegExp(`(<row\\b[^>]*r="${r}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
    sheetXml = sheetXml.replace(rowRegex, (_, start, content, end) => {
      const newCell = `<c r="${newColName}${r}" s="20"/>`;
      return `${start}${content}${newCell}${end}`;
    });
  }

  // Update date maps
  dateInfo.colDateMap[newColName] = dateStr;
  dateInfo.dateColMap[dateStr] = newColName;
  dateInfo.lastCol = newColName;

  return { updatedSheetXml: sheetXml, colName: newColName };
}

/**
 * Recalculate summary cells (H=Present, I=Absent, J=Leave, K=%) for a student row
 */
function recalculateStudentRow(
  rowContent: string,
  rowNum: number,
  dateCols: string[],
  sharedStrings: string[]
): string {
  let presentCount = 0;
  let absentCount = 0;
  let leaveCount = 0;

  for (const col of dateCols) {
    const cellRegex = new RegExp(`<c\\b[^>]*r="${col}${rowNum}"(?:\\/>|[^>]*>(?:[\\s\\S]*?<v>([^<]*)<\\/v>)?(?:[\\s\\S]*?<\\/c>))`);
    const m = rowContent.match(cellRegex);
    if (m && m[1]) {
      const val = m[1];
      const isString = /t="s"/.test(m[0]);
      const text = isString ? sharedStrings[Number(val)] : val;
      if (text === 'P' || text === 'p') presentCount++;
      else if (text === 'A' || text === 'a') absentCount++;
      else if (text === 'L' || text === 'l') leaveCount++;
    }
  }

  const totalClasses = 90;
  const percentage = totalClasses > 0 ? (presentCount / totalClasses) : 0;

  // Replace H (Present)
  rowContent = rowContent.replace(
    new RegExp(`(<c\\b[^>]*r="H${rowNum}"[^>]*>)(?:[\\s\\S]*?<v>[^<]*<\\/v>)?([\\s\\S]*?<\\/c>)`),
    `$1<f>COUNTIF(L${rowNum}:DP${rowNum},"p")</f><v>${presentCount}</v></c>`
  );

  // Replace I (Absent)
  rowContent = rowContent.replace(
    new RegExp(`(<c\\b[^>]*r="I${rowNum}"[^>]*>)(?:[\\s\\S]*?<v>[^<]*<\\/v>)?([\\s\\S]*?<\\/c>)`),
    `$1<f>COUNTIF(L${rowNum}:DP${rowNum},"A")</f><v>${absentCount}</v></c>`
  );

  // Replace J (Leave)
  rowContent = rowContent.replace(
    new RegExp(`(<c\\b[^>]*r="J${rowNum}"[^>]*>)(?:[\\s\\S]*?<v>[^<]*<\\/v>)?([\\s\\S]*?<\\/c>)`),
    `$1<f>COUNTIF(L${rowNum}:DP${rowNum},"L")</f><v>${leaveCount}</v></c>`
  );

  // Replace K (%)
  rowContent = rowContent.replace(
    new RegExp(`(<c\\b[^>]*r="K${rowNum}"[^>]*>)(?:[\\s\\S]*?<v>[^<]*<\\/v>)?([\\s\\S]*?<\\/c>)`),
    `$1<f>H${rowNum}/G${rowNum}</f><v>${percentage}</v></c>`
  );

  return rowContent;
}

/**
 * Public: Get Master Workbook Info and current status
 */
export async function getMasterWorkbookInfo(): Promise<MasterWorkbookInfo> {
  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const meta = readMeta();
    const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    const sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const students = parseStudents(sheetXml, sharedStrings);
    const availableDates = Object.values(dateInfo.colDateMap).sort();

    return {
      workbookName: meta.workbookName,
      batchName: meta.batchName,
      worksheetName: meta.worksheetName,
      lastSyncedAt: meta.lastSyncedAt,
      version: meta.version,
      startDate: availableDates[0] ?? '2026-10-19',
      endDate: availableDates[availableDates.length - 1] ?? '2027-01-20',
      totalStudents: students.length,
      availableDates,
      students,
      syncStatus: meta.errors.length > 0 ? 'ERROR' : 'HEALTHY',
      errors: meta.errors,
    };
  });
}

/**
 * Public: Get detailed attendance for a specific date from the Master Workbook
 */
export async function getMasterAttendanceForDate(dateStr: string): Promise<{
  date: string;
  column: string | null;
  weekday: string;
  presentCount: number;
  absentCount: number;
  unmarkedCount: number;
  records: DateAttendanceRecord[];
}> {
  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    const sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const students = parseStudents(sheetXml, sharedStrings);
    const col = dateInfo.dateColMap[dateStr] ?? null;

    if (!col) {
      return {
        date: dateStr,
        column: null,
        weekday: '',
        presentCount: 0,
        absentCount: 0,
        unmarkedCount: students.length,
        records: students.map((s) => ({
          row: s.row,
          sno: s.sno,
          admissionNo: s.admissionNo,
          name: s.name,
          status: null,
          cellRef: '',
        })),
      };
    }

    const records: DateAttendanceRecord[] = [];
    let presentCount = 0;
    let absentCount = 0;
    let unmarkedCount = 0;

    for (const s of students) {
      const cellRef = `${col}${s.row}`;
      const cellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>(?:[\\s\\S]*?<v>([^<]*)<\\/v>)?(?:[\\s\\S]*?<\\/c>))`);
      const match = sheetXml.match(cellRegex);
      let status: 'P' | 'A' | 'L' | null = null;

      if (match && match[1] !== undefined && match[1] !== '') {
        const val = match[1];
        const isString = /t="s"/.test(match[0]);
        const text = isString ? sharedStrings[Number(val)] : val;
        if (text === 'P' || text === 'p') status = 'P';
        else if (text === 'A' || text === 'a') status = 'A';
        else if (text === 'L' || text === 'l') status = 'L';
      }

      if (status === 'P') presentCount++;
      else if (status === 'A') absentCount++;
      else unmarkedCount++;

      records.push({
        row: s.row,
        sno: s.sno,
        admissionNo: s.admissionNo,
        name: s.name,
        status,
        cellRef,
      });
    }

    return {
      date: dateStr,
      column: col,
      weekday: dateInfo.weekdays[col] ?? '',
      presentCount,
      absentCount,
      unmarkedCount,
      records,
    };
  });
}

/**
 * Public: Record student attendance in the Master Excel Workbook (e.g. on QR scan)
 * Serialized under lock to guarantee thread-safety.
 */
export async function recordStudentAttendanceInMaster(
  student: { studentId: string; fullName: string; email: string },
  dateStr: string,
  status: 'P' | 'A' | 'L' = 'P'
): Promise<{ success: boolean; row: number; column: string; alreadyRecorded: boolean; message: string }> {
  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    let sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const students = parseStudents(sheetXml, sharedStrings);

    // 1. Match Student
    const matched = matchStudentToExcelRow(student, students);
    if (!matched) {
      const err = `Student matching error: Could not identify Excel row for student '${student.fullName}' (${student.studentId}).`;
      const meta = readMeta();
      if (!meta.errors.includes(err)) {
        meta.errors.push(err);
        saveMeta(meta);
      }
      throw new Error(err);
    }

    // 2. Ensure Date Column
    const { updatedSheetXml, colName } = ensureDateColumn(sheetXml, dateStr, dateInfo);
    sheetXml = updatedSheetXml;

    const cellRef = `${colName}${matched.row}`;
    const stringId = status === 'P' ? SHARED_STRING_PRESENT : status === 'A' ? SHARED_STRING_ABSENT : SHARED_STRING_LEAVE;

    // 3. Check existing value
    const cellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>(?:[\\s\\S]*?<v>([^<]*)<\\/v>)?(?:[\\s\\S]*?<\\/c>))`);
    const existingMatch = sheetXml.match(cellRegex);
    if (existingMatch && existingMatch[1] !== undefined && existingMatch[1] !== '') {
      const val = existingMatch[1];
      const isString = /t="s"/.test(existingMatch[0]);
      const currentText = isString ? sharedStrings[Number(val)] : val;
      if (currentText.toUpperCase() === status.toUpperCase()) {
        return {
          success: true,
          row: matched.row,
          column: colName,
          alreadyRecorded: true,
          message: `Attendance already recorded as ${status} in Excel master workbook.`,
        };
      }
    }

    // 4. Update or Insert Cell in Student Row
    const rowRegex = new RegExp(`(<row\\b[^>]*r="${matched.row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
    const rowMatch = sheetXml.match(rowRegex);
    if (!rowMatch) {
      throw new Error(`Row ${matched.row} not found in sheet1.xml`);
    }

    let rowContent = rowMatch[2];
    const targetCellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>[\\s\\S]*?<\\/c>)`);
    const newCellXml = `<c r="${cellRef}" s="20" t="s"><v>${stringId}</v></c>`;

    if (targetCellRegex.test(rowContent)) {
      rowContent = rowContent.replace(targetCellRegex, newCellXml);
    } else {
      // Find sorted alphabetical insertion point
      const targetColIdx = colNameToIndex(colName);
      const allCells = [...rowContent.matchAll(/<c\b[^>]*r="([A-Z]+)\d+"[^>]*>(?:[\s\S]*?<\/c>)?/g)];
      let inserted = false;
      for (const c of allCells) {
        const cCol = c[1];
        if (colNameToIndex(cCol) > targetColIdx) {
          const insertIdx = c.index!;
          rowContent = rowContent.slice(0, insertIdx) + newCellXml + rowContent.slice(insertIdx);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        rowContent += newCellXml;
      }
    }

    // 5. Recalculate row summaries
    const allDateCols = Object.keys(dateInfo.colDateMap);
    rowContent = recalculateStudentRow(rowContent, matched.row, allDateCols, sharedStrings);

    // 6. Write back to sheetXml
    sheetXml = sheetXml.replace(rowRegex, `${rowMatch[1]}${rowContent}${rowMatch[3]}`);
    fs.writeFileSync(sheet1Path, sheetXml, 'utf8');

    // 7. Atomically rebuild master-attendance.xlsx
    await rebuildMasterXlsx();

    return {
      success: true,
      row: matched.row,
      column: colName,
      alreadyRecorded: false,
      message: `Successfully marked ${status} for ${matched.name} on ${dateStr} in column ${colName}.`,
    };
  });
}

/**
 * Public: Finalize Daily Attendance (Administrator Action)
 * Marks all unmarked students for dateStr as 'A' (Absent).
 * Preserves all 'P' and existing historical records.
 */
export async function finalizeDailyAttendanceInMaster(
  dateStr: string,
  adminEmail: string
): Promise<{
  success: boolean;
  date: string;
  column: string;
  finalizedCount: number;
  presentCount: number;
  absentCount: number;
  version: number;
}> {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only authorized administrator may finalize attendance.');
  }

  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    let sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const { updatedSheetXml, colName } = ensureDateColumn(sheetXml, dateStr, dateInfo);
    sheetXml = updatedSheetXml;

    const students = parseStudents(sheetXml, sharedStrings);
    let finalizedCount = 0;
    let presentCount = 0;
    let absentCount = 0;
    const allDateCols = Object.keys(dateInfo.colDateMap);

    for (const s of students) {
      const cellRef = `${colName}${s.row}`;
      const rowRegex = new RegExp(`(<row\\b[^>]*r="${s.row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
      const rowMatch = sheetXml.match(rowRegex);
      if (!rowMatch) continue;

      let rowContent = rowMatch[2];
      const cellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>(?:[\\s\\S]*?<v>([^<]*)<\\/v>)?(?:[\\s\\S]*?<\\/c>))`);
      const m = rowContent.match(cellRegex);

      let status: 'P' | 'A' | 'L' | null = null;
      if (m && m[1] !== undefined && m[1] !== '') {
        const val = m[1];
        const isString = /t="s"/.test(m[0]);
        const text = isString ? sharedStrings[Number(val)] : val;
        if (text === 'P' || text === 'p') status = 'P';
        else if (text === 'A' || text === 'a') status = 'A';
        else if (text === 'L' || text === 'l') status = 'L';
      }

      if (status === 'P') {
        presentCount++;
      } else if (status === 'A') {
        absentCount++;
      } else {
        // Unmarked! Mark as 'A' (Absent)
        finalizedCount++;
        absentCount++;
        const targetCellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>[\\s\\S]*?<\\/c>)`);
        const absentCellXml = `<c r="${cellRef}" s="20" t="s"><v>${SHARED_STRING_ABSENT}</v></c>`;

        if (targetCellRegex.test(rowContent)) {
          rowContent = rowContent.replace(targetCellRegex, absentCellXml);
        } else {
          rowContent += absentCellXml;
        }

        rowContent = recalculateStudentRow(rowContent, s.row, allDateCols, sharedStrings);
        sheetXml = sheetXml.replace(rowRegex, `${rowMatch[1]}${rowContent}${rowMatch[3]}`);
      }
    }

    fs.writeFileSync(sheet1Path, sheetXml, 'utf8');
    await rebuildMasterXlsx();
    const meta = readMeta();

    return {
      success: true,
      date: dateStr,
      column: colName,
      finalizedCount,
      presentCount,
      absentCount,
      version: meta.version,
    };
  });
}

/**
 * Public: Correct an Attendance Entry (Administrator Action)
 * Requires mandatory audit reason.
 */
export async function correctAttendanceEntryInMaster(params: {
  row: number;
  dateStr: string;
  newStatus: 'P' | 'A' | 'L' | '';
  reason: string;
  adminEmail: string;
}): Promise<{ success: boolean; studentName: string; row: number; cellRef: string; version: number }> {
  const { row, dateStr, newStatus, reason, adminEmail } = params;

  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only authorized administrator may correct attendance.');
  }

  if (!reason || reason.trim().length < 5) {
    throw new Error('Mandatory audit reason must be at least 5 characters.');
  }

  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const sheet1Path = path.join(UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    let sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const { updatedSheetXml, colName } = ensureDateColumn(sheetXml, dateStr, dateInfo);
    sheetXml = updatedSheetXml;

    const cellRef = `${colName}${row}`;
    const rowRegex = new RegExp(`(<row\\b[^>]*r="${row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
    const rowMatch = sheetXml.match(rowRegex);
    if (!rowMatch) {
      throw new Error(`Row ${row} not found in master sheet.`);
    }

    let rowContent = rowMatch[2];
    const targetCellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>[\\s\\S]*?<\\/c>)`);

    let newCellXml = `<c r="${cellRef}" s="20"/>`;
    if (newStatus === 'P') {
      newCellXml = `<c r="${cellRef}" s="20" t="s"><v>${SHARED_STRING_PRESENT}</v></c>`;
    } else if (newStatus === 'A') {
      newCellXml = `<c r="${cellRef}" s="20" t="s"><v>${SHARED_STRING_ABSENT}</v></c>`;
    } else if (newStatus === 'L') {
      newCellXml = `<c r="${cellRef}" s="20" t="s"><v>${SHARED_STRING_LEAVE}</v></c>`;
    }

    if (targetCellRegex.test(rowContent)) {
      rowContent = rowContent.replace(targetCellRegex, newCellXml);
    } else {
      rowContent += newCellXml;
    }

    const allDateCols = Object.keys(dateInfo.colDateMap);
    rowContent = recalculateStudentRow(rowContent, row, allDateCols, sharedStrings);
    sheetXml = sheetXml.replace(rowRegex, `${rowMatch[1]}${rowContent}${rowMatch[3]}`);

    fs.writeFileSync(sheet1Path, sheetXml, 'utf8');
    await rebuildMasterXlsx();

    const students = parseStudents(sheetXml, sharedStrings);
    const studentObj = students.find((s) => s.row === row);
    const meta = readMeta();

    return {
      success: true,
      studentName: studentObj?.name || `Row ${row}`,
      row,
      cellRef,
      version: meta.version,
    };
  });
}

/**
 * Public: Get path to canonical master workbook file for download
 */
export function getMasterWorkbookFilePath(): string {
  if (fs.existsSync(MASTER_XLSX_PATH)) {
    return MASTER_XLSX_PATH;
  }
  if (fs.existsSync(INITIAL_BACKUP_PATH)) {
    return INITIAL_BACKUP_PATH;
  }
  if (fs.existsSync(SOURCE_DOWNLOAD_PATH)) {
    return SOURCE_DOWNLOAD_PATH;
  }
  throw new Error('Master Excel workbook B-19-AI Builder (1) (3).xlsx not found.');
}
