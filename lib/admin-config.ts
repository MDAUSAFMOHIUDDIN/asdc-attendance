/**
 * ASDC Attendance - Institute Administration Configuration
 * 
 * ==============================================================================
 * SOLE AUTHORIZED ADMINISTRATOR
 * Only this exact Google account may access the Admin Dashboard and all
 * administrative controls (attendance corrections, student records, QR generator).
 * ==============================================================================
 */

export const SOLE_ADMIN_EMAIL = 'mdausafmohiuddin@gmail.com';
export const ADMIN_EMAIL_1 = SOLE_ADMIN_EMAIL;

export const ALLOWED_ADMIN_EMAILS: readonly string[] = [
  SOLE_ADMIN_EMAIL.toLowerCase().trim(),
];

export function isAuthorizedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().trim() === SOLE_ADMIN_EMAIL.toLowerCase().trim();
}

/**
 * Institute Attendance Settings
 */
export const QR_ACCESS_DISABLED_MESSAGE =
  'ADMIN HAS DISABLED ATTENDANCE ACCESS. You cannot scan the classroom QR or mark attendance right now. Please wait until the administrator enables access.';

export const INSTITUTE_CONFIG = {
  INSTITUTE_NAME: 'ASDC',
  INSTITUTE_FULL_NAME: 'ASDC Attendance',
  DEFAULT_BATCH_ID: 'ai-builder-mastery',
  DEFAULT_BATCH_NAME: 'AI Builder Mastery',
  CLASSROOM_SECRET_KEY: 'ASDC_AIMASTERY_ROOM_2026',
  TIMEZONE: 'Asia/Kolkata',
  // Attendance is open 24/7 anytime on class dates
  ATTENDANCE_WINDOW_DESC: 'Open Anytime (24/7 on class days)',
  // Active class days: Monday through Saturday (1 = Monday, 6 = Saturday, 0 = Sunday)
  DEFAULT_ACTIVE_DAYS_OF_WEEK: [1, 2, 3, 4, 5, 6],
};
