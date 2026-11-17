import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  where,
  orderBy,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  AttendanceRecord,
  AttendanceStatus,
  AuditLog,
  Announcement,
  Holiday,
  FinalizedDateRecord,
  StudentAttendanceSummary,
  StudentProfile,
} from './types';
import { getISTTimeInfo, checkAttendanceWindow, isScheduledClassDate } from './date-utils';
import { INSTITUTE_CONFIG } from './admin-config';

/**
 * Fetch all attendance records for a specific student UID
 */
export async function getStudentAttendanceRecords(
  studentUid: string
): Promise<AttendanceRecord[]> {
  try {
    const q = query(
      collection(db, 'attendance'),
      where('studentUid', '==', studentUid)
    );
    const snap = await getDocs(q);
    const records: AttendanceRecord[] = [];
    snap.forEach((d) => {
      records.push(d.data() as AttendanceRecord);
    });
    // Sort descending by classDate
    records.sort((a, b) => b.classDate.localeCompare(a.classDate));
    return records;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'attendance');
    return [];
  }
}

/**
 * Fetch all attendance records for a specific date (for admin dashboard)
 */
export async function getAttendanceRecordsForDate(
  dateStr: string
): Promise<Record<string, AttendanceRecord>> {
  try {
    const q = query(
      collection(db, 'attendance'),
      where('classDate', '==', dateStr)
    );
    const snap = await getDocs(q);
    const recordsMap: Record<string, AttendanceRecord> = {};
    snap.forEach((d) => {
      const data = d.data() as AttendanceRecord;
      if (data) {
        if (data.studentUid) recordsMap[data.studentUid] = data;
        if (data.studentId) {
          recordsMap[data.studentId] = data;
          recordsMap[data.studentId.toUpperCase()] = data;
        }
      }
    });
    return recordsMap;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'attendance');
    return {};
  }
}

/**
 * Fetch all finalized dates from authoritative database
 */
export async function getFinalizedDates(): Promise<Record<string, FinalizedDateRecord>> {
  try {
    const snap = await getDocs(collection(db, 'finalized_dates'));
    const map: Record<string, FinalizedDateRecord> = {};
    snap.forEach((d) => {
      const f = d.data() as FinalizedDateRecord;
      if (f && f.date) {
        map[f.date] = f;
      }
    });
    return map;
  } catch (error) {
    console.warn('Finalized dates read notice:', error);
    return {};
  }
}

/**
 * Check if a specific class date has been finalized by administrator
 */
export async function isDateFinalized(dateStr: string): Promise<boolean> {
  try {
    const docRef = doc(db, 'finalized_dates', dateStr);
    const snap = await getDoc(docRef);
    return snap.exists();
  } catch {
    return false;
  }
}

/**
 * Fetch all holidays
 */
export async function getHolidays(): Promise<Record<string, Holiday>> {
  try {
    const snap = await getDocs(collection(db, 'holidays'));
    const holidaysMap: Record<string, Holiday> = {};
    snap.forEach((d) => {
      const h = d.data() as Holiday;
      holidaysMap[h.date] = h;
    });
    return holidaysMap;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'holidays');
    return {};
  }
}

/**
 * Fetch all announcements
 */
export async function getAnnouncements(): Promise<Announcement[]> {
  try {
    const snap = await getDocs(collection(db, 'announcements'));
    const list: Announcement[] = [];
    snap.forEach((d) => {
      list.push(d.data() as Announcement);
    });
    // Sort descending by createdAt
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'announcements');
    return [];
  }
}

/**
 * Fetch all registered students (Admin only)
 */
export async function getAllStudents(): Promise<StudentProfile[]> {
  try {
    const snap = await getDocs(collection(db, 'students'));
    const students: StudentProfile[] = [];
    snap.forEach((d) => {
      students.push(d.data() as StudentProfile);
    });
    // Sort by studentId ascending (ASDC-0001, ASDC-0002)
    students.sort((a, b) => a.studentId.localeCompare(b.studentId));
    return students;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'students');
    return [];
  }
}

/**
 * Fetch audit logs (Admin only)
 */
export async function getAuditLogs(): Promise<AuditLog[]> {
  try {
    const snap = await getDocs(collection(db, 'audit_logs'));
    const logs: AuditLog[] = [];
    snap.forEach((d) => {
      logs.push(d.data() as AuditLog);
    });
    logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return logs;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    return [];
  }
}

/**
 * Admin action: Correct an attendance record with mandatory audit reason
 */
export async function correctAttendanceRecord(params: {
  adminEmail: string;
  student: StudentProfile;
  classDate: string;
  newStatus: AttendanceStatus;
  reason: string;
}): Promise<AttendanceRecord> {
  const { adminEmail, student, classDate, newStatus, reason } = params;
  if (!reason || reason.trim().length < 5) {
    throw new Error('A detailed audit reason (at least 5 characters) is required for attendance correction.');
  }

  const attendanceDocId = `${student.uid}_${classDate}`;
  const attendanceRef = doc(db, 'attendance', attendanceDocId);
  const nowIso = new Date().toISOString();

  let previousStatus: AttendanceStatus = 'ABSENT';
  let existingFinalizationStatus: 'FINALIZED' | 'UNFINALIZED' = 'FINALIZED';
  const existingSnap = await getDoc(attendanceRef);
  if (existingSnap.exists()) {
    const exData = existingSnap.data() as AttendanceRecord;
    previousStatus = exData.status || 'ABSENT';
    if (exData.finalizationStatus) {
      existingFinalizationStatus = exData.finalizationStatus;
    }
  }

  const updatedRecord: AttendanceRecord = {
    id: attendanceDocId,
    studentUid: student.uid,
    studentId: student.studentId,
    studentName: student.fullName,
    studentEmail: student.email,
    classDate,
    batchId: student.batchId || INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
    status: newStatus,
    source: 'ADMIN_MANUAL',
    verifiedAt: nowIso,
    submittedAt: nowIso,
    timestamp: nowIso,
    eventId: `att_corr_${Date.now()}_${student.studentId}`,
    dbCommitStatus: 'COMMITTED',
    excelSyncStatus: 'SYNCED',
    finalizationStatus: existingFinalizationStatus,
    correctionReason: reason.trim(),
  };

  // 1. Write authoritative attendance record in Firestore
  await setDoc(attendanceRef, updatedRecord);

  // 2. Write audit log
  const logId = `log_${Date.now()}_${student.studentId}`;
  const logRef = doc(db, 'audit_logs', logId);
  const auditLog: AuditLog = {
    id: logId,
    adminEmail,
    action: 'ATTENDANCE_CORRECTION',
    targetStudentId: student.studentId,
    targetStudentName: student.fullName,
    targetDate: classDate,
    previousStatus,
    newStatus,
    reason: reason.trim(),
    timestamp: nowIso,
  };

  await setDoc(logRef, auditLog);

  // 3. Synchronize with Master Excel Register
  try {
    const excelStatus: 'P' | 'A' | 'L' | '' =
      newStatus === 'PRESENT' || (newStatus as any) === 'P'
        ? 'P'
        : newStatus === 'ABSENT' || (newStatus as any) === 'A'
        ? 'A'
        : newStatus === 'EXCUSED' || (newStatus as any) === 'L'
        ? 'L'
        : '';

    let idToken: string | null = null;
    try {
      const { auth } = await import('./firebase');
      if (auth.currentUser) {
        idToken = await auth.currentUser.getIdToken();
      }
    } catch {}

    await fetch('/api/attendance/master-excel/correct', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({
        adminEmail,
        studentId: student.studentId,
        studentName: student.fullName,
        date: classDate,
        newStatus: excelStatus,
        reason: reason.trim(),
      }),
    });
  } catch (syncErr) {
    console.warn('[Attendance Service] Master Excel correction sync notice:', syncErr);
  }

  return updatedRecord;
}

/**
 * Admin action: Add or update a holiday
 */
export async function saveHoliday(params: {
  date: string;
  title: string;
  reason?: string;
  adminEmail: string;
}): Promise<Holiday> {
  const { date, title, reason, adminEmail } = params;
  const holidayRef = doc(db, 'holidays', date);
  const nowIso = new Date().toISOString();

  const holiday: Holiday = {
    id: date,
    date,
    title: title.trim(),
    reason: reason?.trim() || '',
    createdAt: nowIso,
    createdBy: adminEmail,
  };

  await setDoc(holidayRef, holiday);
  return holiday;
}

/**
 * Admin action: Remove a holiday
 */
export async function removeHoliday(date: string): Promise<void> {
  await deleteDoc(doc(db, 'holidays', date));
}

/**
 * Admin action: Create an announcement
 */
export async function createAnnouncement(params: {
  title: string;
  message: string;
  category: 'GENERAL' | 'HOLIDAY' | 'SCHEDULE' | 'URGENT';
  adminEmail: string;
}): Promise<Announcement> {
  const { title, message, category, adminEmail } = params;
  const id = `ann_${Date.now()}`;
  const announcementRef = doc(db, 'announcements', id);
  const nowIso = new Date().toISOString();

  const announcement: Announcement = {
    id,
    title: title.trim(),
    message: message.trim(),
    category,
    batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
    createdAt: nowIso,
    createdBy: adminEmail,
  };

  await setDoc(announcementRef, announcement);
  return announcement;
}

/**
 * Admin action: Delete an announcement
 */
export async function deleteAnnouncement(id: string): Promise<void> {
  await deleteDoc(doc(db, 'announcements', id));
}

/**
 * Compute student attendance summary (Total scheduled, Present, Absent, Attendance %)
 * Respects active class schedule, holidays, and doesn't mark absent before window closes.
 */
export function calculateStudentSummary(
  student: StudentProfile,
  records: AttendanceRecord[],
  holidays: Record<string, Holiday>,
  finalizedDates?: Record<string, any> | Set<string> | string[],
  activeDaysOfWeek: number[] = INSTITUTE_CONFIG.DEFAULT_ACTIVE_DAYS_OF_WEEK
): StudentAttendanceSummary {
  // If student registered recently, count dates from student.createdAt date up to today (or last 30 days)
  const regDateStr = student.createdAt ? student.createdAt.split('T')[0] : '2026-10-01';
  const todayIST = getISTTimeInfo();
  const todayStr = todayIST.dateString;

  // Build finalized dates set
  const finalizedSet = new Set<string>();
  if (finalizedDates) {
    if (finalizedDates instanceof Set) {
      finalizedDates.forEach((d) => finalizedSet.add(d));
    } else if (Array.isArray(finalizedDates)) {
      finalizedDates.forEach((d) => finalizedSet.add(d));
    } else if (typeof finalizedDates === 'object') {
      Object.keys(finalizedDates).forEach((d) => finalizedSet.add(d));
    }
  }

  // Create lookup of recorded attendance
  const recordMap: Record<string, AttendanceRecord> = {};
  for (const r of records) {
    recordMap[r.classDate] = r;
  }

  let totalScheduled = 0;
  let presentCount = 0;
  let absentCount = 0;
  let excusedCount = 0;

  // Iterate over relevant class dates (up to today)
  const [startYear, startMonth, startDay] = regDateStr.split('-').map(Number);
  const cursor = new Date(Date.UTC(startYear, startMonth - 1, startDay, 12, 0, 0));
  const end = new Date(Date.UTC(todayIST.year, todayIST.month - 1, todayIST.day, 12, 0, 0));

  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cursor.getUTCDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}`;

    const isClassDay = isScheduledClassDate(dateStr, holidays, activeDaysOfWeek);

    if (isClassDay) {
      const rec = recordMap[dateStr];
      const isDateFinalized = finalizedSet.has(dateStr);

      if (rec) {
        const isPres = rec.status === 'PRESENT' || (rec.status as any) === 'P';
        const isAbs = rec.status === 'ABSENT' || (rec.status as any) === 'A';
        const isExc = rec.status === 'EXCUSED' || (rec.status as any) === 'L';

        if (isPres) {
          presentCount++;
          totalScheduled++;
        } else if (isExc) {
          excusedCount++;
        } else if (isAbs) {
          absentCount++;
          totalScheduled++;
        }
      } else {
        // No record exists in DB for this date
        // ONLY count as absent if date is explicitly finalized by administrator!
        // Unfinalized dates are NOT marked absent before administrator confirmation.
        if (isDateFinalized) {
          absentCount++;
          totalScheduled++;
        }
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const attendancePercentage =
    totalScheduled > 0
      ? Math.round((presentCount / totalScheduled) * 100)
      : 100;

  return {
    totalClassesScheduled: totalScheduled,
    presentCount,
    absentCount,
    excusedCount,
    attendancePercentage,
  };
}

/**
 * Fetch Canonical Master Excel Workbook information
 */
export async function fetchMasterWorkbookInfo(adminEmail: string): Promise<import('./types').MasterWorkbookInfo> {
  const res = await fetch(`/api/attendance/master-excel/info?adminEmail=${encodeURIComponent(adminEmail)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load master workbook info' }));
    throw new Error(err.error || 'Failed to load master workbook info');
  }
  return res.json();
}

/**
 * Fetch detailed daily records from Canonical Master Excel Workbook
 */
export async function fetchMasterAttendanceForDate(adminEmail: string, date: string): Promise<{
  date: string;
  column: string | null;
  weekday: string;
  presentCount: number;
  absentCount: number;
  unmarkedCount: number;
  records: import('./types').DateAttendanceRecord[];
}> {
  const res = await fetch(`/api/attendance/master-excel/data?adminEmail=${encodeURIComponent(adminEmail)}&date=${encodeURIComponent(date)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to load master attendance data' }));
    throw new Error(err.error || 'Failed to load master attendance data');
  }
  return res.json();
}

/**
 * Finalize daily attendance in Canonical Master Excel Workbook (Admin action)
 */
export async function finalizeMasterDailyAttendance(
  adminEmail: string,
  date: string,
  attendanceRecords?: AttendanceRecord[]
): Promise<{
  success: boolean;
  message: string;
  result: {
    finalizedCount: number;
    presentCount: number;
    absentCount: number;
    version: number;
  };
}> {
  let idToken: string | null = null;
  try {
    const { auth } = await import('./firebase');
    if (auth.currentUser) {
      idToken = await auth.currentUser.getIdToken();
    }
  } catch {}

  const res = await fetch('/api/attendance/master-excel/finalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ adminEmail, date, attendanceRecords }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Finalization failed' }));
    throw new Error(err.error || 'Finalization failed');
  }
  return res.json();
}

/**
 * Correct an attendance cell in Canonical Master Excel Workbook (Admin action)
 */
export async function correctMasterAttendanceEntry(params: {
  adminEmail: string;
  row: number;
  date: string;
  newStatus: 'P' | 'A' | 'L' | '';
  reason: string;
}): Promise<{ success: boolean; message: string; result: any }> {
  const res = await fetch('/api/attendance/master-excel/correct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Correction failed' }));
    throw new Error(err.error || 'Correction failed');
  }
  return res.json();
}

/**
 * Trigger download of the official Master Excel Workbook snapshot
 * Supports desktop and mobile browsers with robust blob handling and meaningful error feedback.
 */
export async function triggerMasterWorkbookDownload(adminEmail: string): Promise<void> {
  const url = `/api/attendance/master-excel/download?adminEmail=${encodeURIComponent(adminEmail)}&t=${Date.now()}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  });

  if (!response.ok) {
    let errorMessage = `Download failed with status ${response.status} (${response.statusText})`;
    try {
      const errorJson = await response.json();
      if (errorJson && errorJson.error) {
        errorMessage = errorJson.error;
      }
    } catch {
      // response wasn't JSON
    }
    throw new Error(errorMessage);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('spreadsheetml') && !contentType.includes('octet-stream')) {
    throw new Error(`Invalid file type received: ${contentType}. Expected XLSX spreadsheet.`);
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new Error('Downloaded file is empty (0 bytes).');
  }

  // Extract filename from Content-Disposition header if available
  let filename = 'B-19-AI Builder (1) (3).xlsx';
  const disposition = response.headers.get('content-disposition');
  if (disposition) {
    const filenameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (filenameMatch && filenameMatch[1]) {
      try {
        filename = decodeURIComponent(filenameMatch[1]);
      } catch {
        filename = filenameMatch[1];
      }
    }
  }

  // Create clean Blob and download for desktop and mobile compatibility
  const downloadBlob = new Blob([blob], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const blobUrl = window.URL.createObjectURL(downloadBlob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();

  // Safely clean up
  setTimeout(() => {
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  }, 1000);
}

