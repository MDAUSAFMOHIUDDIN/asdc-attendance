/**
 * ASDC Attendance - Canonical Master Excel Workbook Service
 * 
 * Official Register: B-19-AI Builder (1) (3).xlsx
 * Sheet: 'B-19-AI Builder'
 * Batch: 'BATCH-19'
 * 
 * Manages the single persistent master Excel workbook with:
 * - Direct OpenXML preservation (layout, styles, formulas, merged cells, history)
 * - Safe Vercel serverless execution: Never modifies read-only deployment directory (/var/task)
 * - Persistent writable Cloud Storage integration (Firebase Storage) with local persistent fallback
 * - Atomic manipulation in writable temporary workspace (os.tmpdir() / /tmp)
 * - Pure Node.js ZIP extraction without external CLI dependencies (no powershell, no unzip)
 * - Date-based column mapping (IST Asia/Kolkata)
 * - Safe concurrency serialization via AsyncLock
 * - Atomic file writes and version tracking
 * - Daily absence finalization (marking unrecorded students 'A')
 * - Administrative corrections with mandatory audit reasoning
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import archiver from 'archiver';
import AsyncLock from 'async-lock';
import { SOLE_ADMIN_EMAIL, isAuthorizedAdmin } from './admin-config.ts';
import { storage, db, FIREBASE_CONFIG } from './firebase.ts';
import { ref, getBytes, uploadBytes } from 'firebase/storage';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import type { AttendanceRecord } from './types.ts';

const lock = new AsyncLock();

// Canonical cloud storage object paths in Firebase Storage
export const CANONICAL_STORAGE_FILE = 'master-attendance/master-attendance.xlsx';
export const CANONICAL_STORAGE_META = 'master-attendance/master-meta.json';

// Bundled Read-Only Template Paths (Inside deployment bundle /var/task - NEVER WRITTEN TO)
const PROJECT_ROOT = process.cwd();
const BUNDLED_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const BUNDLED_BACKUP_DIR = path.join(BUNDLED_DATA_DIR, 'backup');
const BUNDLED_MASTER_XLSX = path.join(BUNDLED_DATA_DIR, 'master-attendance.xlsx');
const BUNDLED_BACKUP_XLSX = path.join(BUNDLED_BACKUP_DIR, 'B-19-AI Builder (1) (3).initial-backup.xlsx');
const BUNDLED_META_PATH = path.join(BUNDLED_DATA_DIR, 'master-meta.json');
const SOURCE_DOWNLOAD_PATH = 'C:\\Users\\Students\\Downloads\\B-19-AI Builder (1) (3).xlsx';

// Writable Temporary Directory in os.tmpdir() (/tmp on Vercel / Linux)
const TMP_BASE_DIR = path.join(os.tmpdir(), 'asdc-excel-master');
const TMP_MASTER_XLSX = path.join(TMP_BASE_DIR, 'master-attendance.xlsx');
const TMP_META_PATH = path.join(TMP_BASE_DIR, 'master-meta.json');
const TMP_UNPACKED_DIR = path.join(TMP_BASE_DIR, 'unpacked');

/**
 * Checks whether a given directory is writable
 */
function isDirectoryWritable(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const testFile = path.join(dir, `.test_write_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

// Persistent fallback directory (used if configured or during local dev when data/ is writable)
const PERSISTENT_STORAGE_ENV = process.env.PERSISTENT_STORAGE_DIR || null;
export const LOCAL_PERSISTENT_DIR = (() => {
  if (PERSISTENT_STORAGE_ENV && isDirectoryWritable(PERSISTENT_STORAGE_ENV)) {
    return PERSISTENT_STORAGE_ENV;
  }
  // If running locally (not on Vercel) and BUNDLED_DATA_DIR is writable
  if (!process.env.VERCEL && isDirectoryWritable(BUNDLED_DATA_DIR)) {
    const pDir = path.join(BUNDLED_DATA_DIR, 'storage');
    if (!fs.existsSync(pDir)) {
      try { fs.mkdirSync(pDir, { recursive: true }); } catch {}
    }
    return pDir;
  }
  return null;
})();

// Excel OpenXML Base Epoch (1899-12-30 for 1900 date system leap year compatibility)
const EXCEL_EPOCH = new Date(Date.UTC(1899, 11, 30));

// Shared String IDs in the canonical workbook
export const SHARED_STRING_PRESENT = 13; // "P"
export const SHARED_STRING_ABSENT = 14;  // "A"
export const SHARED_STRING_LEAVE = 15;   // "L"

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
 * Ensures the temporary base directory exists in os.tmpdir()
 */
function ensureTmpBaseDir(): void {
  try {
    if (!fs.existsSync(TMP_BASE_DIR)) {
      fs.mkdirSync(TMP_BASE_DIR, { recursive: true });
    }
    if (!fs.existsSync(TMP_UNPACKED_DIR)) {
      fs.mkdirSync(TMP_UNPACKED_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[Excel Master] Error creating temp directories:', err);
  }
}

/**
 * Pure Node.js ZIP extractor: extracts a ZIP buffer into targetDir
 * Zero external CLI dependencies (no powershell, no unzip).
 * 100% serverless and cross-platform compatible.
 */
export function extractZipBuffer(zipBuffer: Buffer, targetDir: string): number {
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP file: End of Central Directory record not found');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let curCdOffset = cdOffset;
  let count = 0;

  for (let i = 0; i < totalEntries; i++) {
    const signature = zipBuffer.readUInt32LE(curCdOffset);
    if (signature !== 0x02014b50) {
      throw new Error(`Invalid Central Directory Header at offset ${curCdOffset}`);
    }

    const compressionMethod = zipBuffer.readUInt16LE(curCdOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(curCdOffset + 20);
    const fileNameLength = zipBuffer.readUInt16LE(curCdOffset + 28);
    const extraLength = zipBuffer.readUInt16LE(curCdOffset + 30);
    const commentLength = zipBuffer.readUInt16LE(curCdOffset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(curCdOffset + 42);

    const fileName = zipBuffer.toString('utf8', curCdOffset + 46, curCdOffset + 46 + fileNameLength);

    const localSig = zipBuffer.readUInt32LE(localHeaderOffset);
    if (localSig !== 0x04034b50) {
      throw new Error(`Invalid Local Header at offset ${localHeaderOffset}`);
    }
    const localFileNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;
    const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    const outPath = path.join(targetDir, fileName.replace(/\//g, path.sep));

    if (fileName.endsWith('/') || fileName.endsWith('\\')) {
      fs.mkdirSync(outPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      let fileData: Buffer;
      if (compressionMethod === 0) {
        fileData = compressedData;
      } else if (compressionMethod === 8) {
        fileData = zlib.inflateRawSync(compressedData);
      } else {
        throw new Error(`Unsupported compression method ${compressionMethod} for ${fileName}`);
      }
      fs.writeFileSync(outPath, fileData);
      count++;
    }

    curCdOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return count;
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
 * Reads Master Metadata from cloud storage, local persistent fallback, or temp
 */
export async function syncLatestMeta(): Promise<MasterMeta> {
  // 1. Try Firebase Storage
  try {
    const metaRef = ref(storage, CANONICAL_STORAGE_META);
    const bytes = await getBytes(metaRef);
    if (bytes && bytes.byteLength > 0) {
      const text = Buffer.from(bytes).toString('utf8');
      const parsed = JSON.parse(text) as MasterMeta;
      saveMetaLocally(parsed);
      return parsed;
    }
  } catch (err) {
    // Expected when cloud bucket is not yet provisioned
  }

  // 2. Try Local Persistent Fallback
  if (LOCAL_PERSISTENT_DIR) {
    const pPath = path.join(LOCAL_PERSISTENT_DIR, 'master-meta.json');
    if (fs.existsSync(pPath)) {
      try {
        const text = fs.readFileSync(pPath, 'utf8');
        const parsed = JSON.parse(text) as MasterMeta;
        saveMetaLocally(parsed);
        return parsed;
      } catch (err) {}
    }
  }

  // 3. Try TMP_META_PATH
  if (fs.existsSync(TMP_META_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TMP_META_PATH, 'utf8'));
    } catch (err) {}
  }

  // 4. Try bundled read-only meta template
  if (fs.existsSync(BUNDLED_META_PATH)) {
    try {
      const meta = JSON.parse(fs.readFileSync(BUNDLED_META_PATH, 'utf8'));
      saveMetaLocally(meta);
      return meta;
    } catch (err) {}
  }

  // Default fallback meta
  const defaultMeta: MasterMeta = {
    workbookName: 'B-19-AI Builder (1) (3).xlsx',
    batchName: 'BATCH-19 (AI Builder)',
    worksheetName: 'B-19-AI Builder',
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    errors: [],
    studentMappings: {},
  };
  saveMetaLocally(defaultMeta);
  return defaultMeta;
}

/**
 * Saves Master Metadata to local writable paths
 */
function saveMetaLocally(meta: MasterMeta): void {
  ensureTmpBaseDir();
  try {
    fs.writeFileSync(TMP_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {}

  if (LOCAL_PERSISTENT_DIR) {
    try {
      fs.writeFileSync(path.join(LOCAL_PERSISTENT_DIR, 'master-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {}
  }
}

/**
 * Synchronous local meta reader for in-memory / temp operations
 */
function readMeta(): MasterMeta {
  if (fs.existsSync(TMP_META_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(TMP_META_PATH, 'utf8'));
    } catch {}
  }
  if (LOCAL_PERSISTENT_DIR) {
    const pPath = path.join(LOCAL_PERSISTENT_DIR, 'master-meta.json');
    if (fs.existsSync(pPath)) {
      try {
        return JSON.parse(fs.readFileSync(pPath, 'utf8'));
      } catch {}
    }
  }
  if (fs.existsSync(BUNDLED_META_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(BUNDLED_META_PATH, 'utf8'));
    } catch {}
  }
  return {
    workbookName: 'B-19-AI Builder (1) (3).xlsx',
    batchName: 'BATCH-19 (AI Builder)',
    worksheetName: 'B-19-AI Builder',
    version: 1,
    lastSyncedAt: new Date().toISOString(),
    errors: [],
    studentMappings: {},
  };
}

/**
 * Download canonical master workbook buffer from persistent cloud storage (Firestore settings/master_workbook),
 * falling back to Firebase Storage, local persistent storage, or bundled seed.
 */
export async function downloadLatestMasterWorkbook(): Promise<Buffer> {
  // 1. Try Firestore persistent document settings/master_workbook (100% persistent across Vercel serverless containers)
  try {
    const docRef = doc(db, 'settings', 'master_workbook');
    const snap = await getDoc(docRef);
    if (snap.exists()) {
      const data = snap.data();
      if (data?.base64 && typeof data.base64 === 'string') {
        const buf = Buffer.from(data.base64, 'base64');
        if (buf.length > 0 && buf.readUInt32LE(0) === 0x04034b50) {
          ensureTmpBaseDir();
          fs.writeFileSync(TMP_MASTER_XLSX, buf);
          return buf;
        }
      }
    }
  } catch (err) {
    // Firestore read notice
  }

  // 2. Try Firebase Storage
  try {
    const storageRef = ref(storage, CANONICAL_STORAGE_FILE);
    const bytes = await getBytes(storageRef);
    if (bytes && bytes.byteLength > 0) {
      const buf = Buffer.from(bytes);
      ensureTmpBaseDir();
      fs.writeFileSync(TMP_MASTER_XLSX, buf);
      return buf;
    }
  } catch (err: any) {
    // Bucket not yet provisioned or network unreachable
  }

  // 3. Try Local Persistent Fallback Directory
  if (LOCAL_PERSISTENT_DIR) {
    const pPath = path.join(LOCAL_PERSISTENT_DIR, 'master-attendance.xlsx');
    if (fs.existsSync(pPath)) {
      try {
        const buf = fs.readFileSync(pPath);
        if (buf && buf.length > 0) {
          ensureTmpBaseDir();
          fs.writeFileSync(TMP_MASTER_XLSX, buf);
          return buf;
        }
      } catch (err) {}
    }
  }

  // 4. Try TMP_MASTER_XLSX (e.g. warm serverless container)
  if (fs.existsSync(TMP_MASTER_XLSX)) {
    try {
      const buf = fs.readFileSync(TMP_MASTER_XLSX);
      if (buf && buf.length > 0) return buf;
    } catch (err) {}
  }

  // 5. Initial Seed from Read-Only Bundled Assets (Never modified)
  let seedPath: string | null = null;
  if (fs.existsSync(BUNDLED_MASTER_XLSX)) {
    seedPath = BUNDLED_MASTER_XLSX;
  } else if (fs.existsSync(BUNDLED_BACKUP_XLSX)) {
    seedPath = BUNDLED_BACKUP_XLSX;
  } else if (fs.existsSync(SOURCE_DOWNLOAD_PATH)) {
    seedPath = SOURCE_DOWNLOAD_PATH;
  }

  if (seedPath) {
    const buf = fs.readFileSync(seedPath);
    ensureTmpBaseDir();
    fs.writeFileSync(TMP_MASTER_XLSX, buf);

    // Seed persistent cloud storage and local persistent fallback asynchronously
    const meta = readMeta();
    uploadMasterWorkbookToStorage(buf, meta).catch((err) => {
      console.warn('[Excel Storage] Initial cloud seed notice:', err?.message);
    });

    return buf;
  }

  throw new Error('Canonical master Excel workbook template could not be found.');
}

/**
 * Upload the master workbook and metadata to persistent cloud storage (Firestore + Firebase Storage)
 * and persistent storage fallback.
 */
export async function uploadMasterWorkbookToStorage(
  buffer: Buffer,
  meta: MasterMeta,
  idToken?: string | null
): Promise<void> {
  // 1. Save to Firestore settings/master_workbook (Guarantees persistence across Vercel serverless containers)
  try {
    const docRef = doc(db, 'settings', 'master_workbook');
    await setDoc(
      docRef,
      {
        base64: buffer.toString('base64'),
        version: meta.version,
        lastSyncedAt: meta.lastSyncedAt,
        workbookName: meta.workbookName,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (fsErr) {
    console.warn('[Excel Storage] Firestore master workbook write notice:', fsErr);
  }

  // 1b. If idToken is provided, also push via authenticated Firestore REST API
  if (idToken) {
    try {
      const restUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents/settings/master_workbook`;
      await fetch(restUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            base64: { stringValue: buffer.toString('base64') },
            version: { integerValue: String(meta.version) },
            lastSyncedAt: { stringValue: meta.lastSyncedAt },
            workbookName: { stringValue: meta.workbookName },
            updatedAt: { stringValue: new Date().toISOString() },
          },
        }),
      });
    } catch (restErr) {
      console.warn('[Excel Storage] REST upload note:', restErr);
    }
  }

  // 2. Upload to Firebase Storage
  try {
    const storageRef = ref(storage, CANONICAL_STORAGE_FILE);
    await uploadBytes(storageRef, buffer, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      customMetadata: {
        version: String(meta.version),
        lastSyncedAt: meta.lastSyncedAt,
      },
    });

    const metaRef = ref(storage, CANONICAL_STORAGE_META);
    await uploadBytes(metaRef, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'), {
      contentType: 'application/json',
    });
  } catch (err: any) {
    // Cloud storage notice
  }

  // 3. Save to Local Persistent Fallback if available
  if (LOCAL_PERSISTENT_DIR) {
    try {
      fs.writeFileSync(path.join(LOCAL_PERSISTENT_DIR, 'master-attendance.xlsx'), buffer);
      fs.writeFileSync(path.join(LOCAL_PERSISTENT_DIR, 'master-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Excel Storage] Note saving to persistent fallback directory:', err);
    }
  }

  // 4. Always keep local tmp cache updated
  ensureTmpBaseDir();
  try {
    fs.writeFileSync(TMP_MASTER_XLSX, buffer);
    fs.writeFileSync(TMP_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) {}
}

/**
 * Synchronize workspace from storage before applying modifications
 */
async function syncFromStorage(): Promise<void> {
  ensureTmpBaseDir();
  try {
    const storageRef = ref(storage, CANONICAL_STORAGE_FILE);
    const bytes = await getBytes(storageRef);
    if (bytes && bytes.byteLength > 0) {
      const buf = Buffer.from(bytes);
      fs.writeFileSync(TMP_MASTER_XLSX, buf);
      extractZipBuffer(buf, TMP_UNPACKED_DIR);
      await syncLatestMeta();
      return;
    }
  } catch (err) {}

  // If TMP_MASTER_XLSX does not exist, download or seed
  if (!fs.existsSync(TMP_MASTER_XLSX)) {
    const buf = await downloadLatestMasterWorkbook();
    extractZipBuffer(buf, TMP_UNPACKED_DIR);
    return;
  }

  // Ensure unpacked sheet exists in TMP_UNPACKED_DIR
  const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
  if (!fs.existsSync(sheet1Path) && fs.existsSync(TMP_MASTER_XLSX)) {
    const zipBuffer = fs.readFileSync(TMP_MASTER_XLSX);
    extractZipBuffer(zipBuffer, TMP_UNPACKED_DIR);
  }
}

/**
 * Initialize Master Workbook environment safely in os.tmpdir()
 */
export async function ensureMasterWorkbook(): Promise<void> {
  ensureTmpBaseDir();

  if (!fs.existsSync(TMP_MASTER_XLSX)) {
    await downloadLatestMasterWorkbook();
  }

  const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
  if (!fs.existsSync(sheet1Path) && fs.existsSync(TMP_MASTER_XLSX)) {
    try {
      const zipBuffer = fs.readFileSync(TMP_MASTER_XLSX);
      extractZipBuffer(zipBuffer, TMP_UNPACKED_DIR);
    } catch (extractErr) {
      console.warn('[Excel Master] Note during initial extraction:', extractErr);
    }
  }

  await syncLatestMeta();
}

/**
 * Rebuild master-attendance.xlsx from TMP_UNPACKED_DIR atomically in os.tmpdir()
 * and upload to cloud storage.
 */
async function rebuildMasterXlsx(idToken?: string | null): Promise<void> {
  ensureTmpBaseDir();
  const tmpOut = path.join(TMP_BASE_DIR, `rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
  const output = fs.createWriteStream(tmpOut);
  const archive = archiver('zip', { zlib: { level: 9 } });

  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', (err: unknown) => reject(err));
    archive.pipe(output);
    archive.directory(TMP_UNPACKED_DIR, false);
    archive.finalize();
  });

  const buffer = fs.readFileSync(tmpOut);

  // Replace TMP_MASTER_XLSX atomically
  if (fs.existsSync(TMP_MASTER_XLSX)) {
    try {
      fs.unlinkSync(TMP_MASTER_XLSX);
    } catch {}
  }
  fs.renameSync(tmpOut, TMP_MASTER_XLSX);

  // Update metadata
  const meta = await syncLatestMeta();
  meta.version += 1;
  meta.lastSyncedAt = new Date().toISOString();
  saveMetaLocally(meta);

  // Upload to Firebase Storage and persistent fallback
  await uploadMasterWorkbookToStorage(buffer, meta, idToken);
}

/**
 * Load Shared Strings from TMP_UNPACKED_DIR
 */
function loadSharedStrings(): string[] {
  const ssPath = path.join(TMP_UNPACKED_DIR, 'xl', 'sharedStrings.xml');
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
    const meta = await syncLatestMeta();
    const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
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
    const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
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
    await syncFromStorage();
    const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
    let sheetXml = fs.readFileSync(sheet1Path, 'utf8');
    const sharedStrings = loadSharedStrings();

    const dateInfo = parseDateColumns(sheetXml);
    const students = parseStudents(sheetXml, sharedStrings);

    // 1. Match Student
    const matched = matchStudentToExcelRow(student, students);
    if (!matched) {
      const err = `Student matching error: Could not identify Excel row for student '${student.fullName}' (${student.studentId}).`;
      const meta = await syncLatestMeta();
      if (!meta.errors.includes(err)) {
        meta.errors.push(err);
        saveMetaLocally(meta);
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

    // 6. Write back to sheetXml in TMP_UNPACKED_DIR
    sheetXml = sheetXml.replace(rowRegex, `${rowMatch[1]}${rowContent}${rowMatch[3]}`);
    fs.writeFileSync(sheet1Path, sheetXml, 'utf8');

    // 7. Atomically rebuild master-attendance.xlsx and upload to cloud storage
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
 * Retrieves authoritative attendance records for dateStr.
 * Writes 'P' for students with confirmed attendance.
 * Writes 'A' for students without confirmed attendance.
 * Preserves all formulas, formatting, student details, and historical records.
 * Saves to canonical persistent storage and verifies workbook contents.
 */
export async function finalizeDailyAttendanceInMaster(
  dateStr: string,
  adminEmail: string,
  attendanceRecords?: AttendanceRecord[],
  idToken?: string | null
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
    await syncFromStorage();
    const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
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

    // Build lookup maps for confirmed present students
    const records = Array.isArray(attendanceRecords) ? attendanceRecords : [];
    const presentStudentUids = new Set<string>();
    const presentStudentIds = new Set<string>();
    const presentNamesNormalized = new Set<string>();

    const normalize = (str: string) =>
      str.toLowerCase().replace(/[\.\,\_\-]/g, ' ').replace(/\s+/g, ' ').trim();

    for (const rec of records) {
      if (rec.status === 'PRESENT') {
        if (rec.studentUid) presentStudentUids.add(rec.studentUid);
        if (rec.studentId) {
          const rawId = rec.studentId.trim().toUpperCase();
          presentStudentIds.add(rawId);
          const numMatch = rawId.match(/(\d+)$/);
          if (numMatch) {
            presentStudentIds.add(String(parseInt(numMatch[1], 10)));
          }
        }
        if (rec.studentName) {
          presentNamesNormalized.add(normalize(rec.studentName));
        }
      }
    }

    const verificationEntries: Record<number, 'P' | 'A' | 'L'> = {};

    for (const s of students) {
      const cellRef = `${colName}${s.row}`;
      const rowRegex = new RegExp(`(<row\\b[^>]*r="${s.row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
      const rowMatch = sheetXml.match(rowRegex);
      if (!rowMatch) continue;

      let rowContent = rowMatch[2];
      const cellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>(?:[\\s\\S]*?<v>([^<]*)<\\/v>)?(?:[\\s\\S]*?<\\/c>))`);
      const m = rowContent.match(cellRegex);

      let currentStatus: 'P' | 'A' | 'L' | null = null;
      if (m && m[1] !== undefined && m[1] !== '') {
        const val = m[1];
        const isString = /t="s"/.test(m[0]);
        const text = isString ? sharedStrings[Number(val)] : val;
        if (text === 'P' || text === 'p') currentStatus = 'P';
        else if (text === 'A' || text === 'a') currentStatus = 'A';
        else if (text === 'L' || text === 'l') currentStatus = 'L';
      }

      // Check whether this student has confirmed attendance in authoritative records
      const sSno = s.sno ? String(parseInt(s.sno, 10)) : '';
      const sAdm = s.admissionNo ? s.admissionNo.trim().toUpperCase() : '';
      const sNameNorm = normalize(s.name);

      const isConfirmedInRecords =
        (sSno && presentStudentIds.has(sSno)) ||
        (sAdm && presentStudentIds.has(sAdm)) ||
        presentNamesNormalized.has(sNameNorm);

      let finalStatus: 'P' | 'A' | 'L';
      if (isConfirmedInRecords || currentStatus === 'P') {
        finalStatus = 'P';
        presentCount++;
      } else if (currentStatus === 'L') {
        finalStatus = 'L';
      } else {
        finalStatus = 'A';
        absentCount++;
        finalizedCount++;
      }

      verificationEntries[s.row] = finalStatus;

      const stringId =
        finalStatus === 'P'
          ? SHARED_STRING_PRESENT
          : finalStatus === 'A'
          ? SHARED_STRING_ABSENT
          : SHARED_STRING_LEAVE;

      const targetCellRegex = new RegExp(`<c\\b[^>]*r="${cellRef}"(?:\\/>|[^>]*>[\\s\\S]*?<\\/c>)`);
      const updatedCellXml = `<c r="${cellRef}" s="20" t="s"><v>${stringId}</v></c>`;

      if (targetCellRegex.test(rowContent)) {
        rowContent = rowContent.replace(targetCellRegex, updatedCellXml);
      } else {
        // Find sorted column insertion point
        const targetColIdx = colNameToIndex(colName);
        const allCells = [...rowContent.matchAll(/<c\b[^>]*r="([A-Z]+)\d+"[^>]*>(?:[\s\S]*?<\/c>)?/g)];
        let inserted = false;
        for (const c of allCells) {
          const cCol = c[1];
          if (colNameToIndex(cCol) > targetColIdx) {
            const insertIdx = c.index!;
            rowContent = rowContent.slice(0, insertIdx) + updatedCellXml + rowContent.slice(insertIdx);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          rowContent += updatedCellXml;
        }
      }

      rowContent = recalculateStudentRow(rowContent, s.row, allDateCols, sharedStrings);
      sheetXml = sheetXml.replace(rowRegex, `${rowMatch[1]}${rowContent}${rowMatch[3]}`);
    }

    fs.writeFileSync(sheet1Path, sheetXml, 'utf8');
    await rebuildMasterXlsx(idToken);

    // Verification Step: Confirm that saved workbook contains the expected P/A entries
    const verifyXml = fs.readFileSync(sheet1Path, 'utf8');
    for (const [rNum, expected] of Object.entries(verificationEntries)) {
      const cRef = `${colName}${rNum}`;
      const cRegex = new RegExp(`<c\\b[^>]*r="${cRef}"[^>]*>[\\s\\S]*?<v>(\\d+)<\\/v>[\\s\\S]*?<\\/c>`);
      const vMatch = verifyXml.match(cRegex);
      if (!vMatch) {
        throw new Error(`Verification error: Cell ${cRef} missing in finalized worksheet.`);
      }
      const actualText = sharedStrings[Number(vMatch[1])];
      if (actualText !== expected) {
        throw new Error(`Verification error: Cell ${cRef} contains '${actualText}', expected '${expected}'.`);
      }
    }

    const meta = await syncLatestMeta();

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
    await syncFromStorage();
    const sheet1Path = path.join(TMP_UNPACKED_DIR, 'xl', 'worksheets', 'sheet1.xml');
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
    const meta = await syncLatestMeta();

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
 * Public: Get path to canonical master workbook file for local access
 */
export function getMasterWorkbookFilePath(): string {
  if (fs.existsSync(TMP_MASTER_XLSX)) {
    return TMP_MASTER_XLSX;
  }
  if (LOCAL_PERSISTENT_DIR) {
    const pPath = path.join(LOCAL_PERSISTENT_DIR, 'master-attendance.xlsx');
    if (fs.existsSync(pPath)) return pPath;
  }
  if (fs.existsSync(BUNDLED_MASTER_XLSX)) {
    return BUNDLED_MASTER_XLSX;
  }
  if (fs.existsSync(BUNDLED_BACKUP_XLSX)) {
    return BUNDLED_BACKUP_XLSX;
  }
  if (fs.existsSync(SOURCE_DOWNLOAD_PATH)) {
    return SOURCE_DOWNLOAD_PATH;
  }
  throw new Error('Master Excel workbook B-19-AI Builder (1) (3).xlsx not found.');
}

/**
 * Public: Get canonical master workbook buffer and filename for HTTP download
 * Downloads the latest version from persistent storage.
 */
export async function getMasterWorkbookBufferForDownload(): Promise<{ buffer: Buffer; filename: string }> {
  return lock.acquire('master-workbook', async () => {
    await ensureMasterWorkbook();
    const buffer = await downloadLatestMasterWorkbook();
    const meta = await syncLatestMeta();
    return {
      buffer,
      filename: meta.workbookName || 'B-19-AI Builder (1) (3).xlsx',
    };
  });
}
