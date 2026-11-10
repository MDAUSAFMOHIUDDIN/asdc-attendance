/**
 * Date and Time utilities for ASDC Attendance
 * All institute operations are strictly anchored to Asia/Kolkata (IST = UTC+05:30).
 */

import { INSTITUTE_CONFIG } from './admin-config.ts';

export interface ISTTimeInfo {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0 = Sun, 1 = Mon, ..., 6 = Sat
  dateString: string; // YYYY-MM-DD
  timeString: string; // HH:MM:SS
  formattedDateTime: string;
}

/**
 * Returns complete time information for a given timestamp in Asia/Kolkata timezone.
 */
export function getISTTimeInfo(dateInput: Date | number = new Date()): ISTTimeInfo {
  const d = typeof dateInput === 'number' ? new Date(dateInput) : dateInput;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: INSTITUTE_CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });

  const parts = formatter.formatToParts(d);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10);
  const day = parseInt(map.day, 10);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);

  const weekdayStr = map.weekday;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayOfWeek = days.indexOf(weekdayStr) >= 0 ? days.indexOf(weekdayStr) : 0;

  const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeString = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

  const formattedDateTime = new Intl.DateTimeFormat('en-IN', {
    timeZone: INSTITUTE_CONFIG.TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(d);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dayOfWeek,
    dateString,
    timeString,
    formattedDateTime,
  };
}

/**
 * Checks attendance window.
 * Requirement: Students must be able to scan and submit attendance at ANY TIME of day.
 * Always returns OPEN for any time of day in Asia/Kolkata.
 */
export function checkAttendanceWindow(dateInput: Date | number = new Date()): {
  isOpen: boolean;
  status: 'OPEN';
  message: string;
  istInfo: ISTTimeInfo;
} {
  const ist = getISTTimeInfo(dateInput);

  return {
    isOpen: true,
    status: 'OPEN',
    message: 'Attendance is OPEN 24/7 anytime today.',
    istInfo: ist,
  };
}

/**
 * Format a YYYY-MM-DD date string into human friendly format e.g. "Thu, 22 Oct 2026"
 */
export function formatDisplayDate(dateStr: string): string {
  if (!dateStr || !dateStr.includes('-')) return dateStr;
  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'UTC',
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return dateStr;
  }
}

/**
 * Format an ISO timestamp string into IST representation
 */
export function formatDisplayTimestamp(isoString: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    return (
      new Intl.DateTimeFormat('en-IN', {
        timeZone: INSTITUTE_CONFIG.TIMEZONE,
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(d) + ' IST'
    );
  } catch {
    return isoString;
  }
}

/**
 * Determine if a given date string (YYYY-MM-DD) is an active scheduled class day.
 */
export function isScheduledClassDate(
  dateStr: string,
  holidays: Record<string, unknown> | Set<string> | string[],
  activeDaysOfWeek: number[] = INSTITUTE_CONFIG.DEFAULT_ACTIVE_DAYS_OF_WEEK
): boolean {
  if (!dateStr) return false;
  if (holidays instanceof Set && holidays.has(dateStr)) return false;
  if (Array.isArray(holidays) && holidays.includes(dateStr)) return false;
  if (
    typeof holidays === 'object' &&
    holidays !== null &&
    (holidays as Record<string, unknown>)[dateStr]
  )
    return false;

  try {
    const [y, m, d] = dateStr.split('-').map(Number);
    const utcDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const dayOfWeek = utcDate.getUTCDay();
    return activeDaysOfWeek.includes(dayOfWeek);
  } catch {
    return true;
  }
}
