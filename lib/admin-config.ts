/**
 * ASDC Attendance - Institute Administration Configuration
 * 
 * ==============================================================================
 * AUTHORIZED ADMINISTRATORS
 * Both Google accounts have full administrative access:
 * 1. mdausafmohiuddin@gmail.com
 * 2. jaferbhelmig@gmail.com
 * ==============================================================================
 */

export const ADMIN_EMAIL_1 = 'mdausafmohiuddin@gmail.com';
export const ADMIN_EMAIL_2 = 'jaferbhelmig@gmail.com';
export const SOLE_ADMIN_EMAIL = ADMIN_EMAIL_1; // For backwards compatibility

export const ALLOWED_ADMIN_EMAILS: readonly string[] = [
  ADMIN_EMAIL_1.toLowerCase().trim(),
  ADMIN_EMAIL_2.toLowerCase().trim(),
];

export function isAuthorizedAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.toLowerCase().trim();
  return ALLOWED_ADMIN_EMAILS.includes(normalized);
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
