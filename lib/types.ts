/**
 * TypeScript Data Models for ASDC Attendance
 */

export interface StudentProfile {
  uid: string;
  studentId: string; // Format: ASDC-0001
  fullName: string;
  phoneNumber: string;
  fatherName: string;
  motherName: string;
  email: string;
  batchId: string;
  batchName: string;
  createdAt: string;
  updatedAt: string;
  readAnnouncementIds?: string[];
}

export type AttendanceStatus = 'PRESENT' | 'ABSENT' | 'EXCUSED';

export interface AttendanceRecord {
  id: string; // Typically `${studentUid}_${classDate}`
  studentUid: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  classDate: string; // YYYY-MM-DD in IST
  batchId: string;
  status: AttendanceStatus;
  source: 'QR_SCAN' | 'ADMIN_MANUAL';
  verifiedAt: string;
  submittedAt?: string;
  correctionReason?: string;
}

export interface Announcement {
  id: string;
  title: string;
  message: string;
  category: 'GENERAL' | 'HOLIDAY' | 'SCHEDULE' | 'URGENT';
  batchId: string;
  createdAt: string;
  createdBy: string;
}

export interface Holiday {
  id: string; // YYYY-MM-DD
  date: string;
  title: string;
  reason?: string;
  createdAt: string;
  createdBy: string;
}

export interface AuditLog {
  id: string;
  adminEmail: string;
  action: string;
  targetStudentId: string;
  targetStudentName: string;
  targetDate: string;
  previousStatus?: string;
  newStatus: string;
  reason: string;
  timestamp: string;
}

export interface ClassroomQRPayload {
  issuer: 'ASDC';
  type: 'classroom_attendance';
  batchId: string;
  classroomId: string;
  challengeId?: string;
  appUrl?: string;
  generatedAt?: string;
}

export type LocationIncidentType =
  | 'OUTSIDE_GEOFENCE'
  | 'LOCATION_PERMISSION_DENIED'
  | 'INSUFFICIENT_LOCATION_ACCURACY'
  | 'INVALID_QR_CHALLENGE'
  | 'REPLAYED_OR_DUPLICATE_ATTEMPT'
  | 'LOCATION_VERIFICATION_FAILED';

export interface LocationIncident {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  incidentType: LocationIncidentType;
  latitude?: number | null;
  longitude?: number | null;
  gpsAccuracy?: number | null;
  distanceMeters?: number | null;
  allowedRadiusMeters?: number;
  challengeId?: string | null;
  details?: string;
  status: 'New' | 'Reviewed';
  timestamp: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
}

export interface GeofenceConfig {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  maxAccuracyMeters: number;
  instituteName: string;
  address: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ActiveQRChallenge {
  challengeId: string;
  status: 'ACTIVE' | 'INACTIVE';
  batchId: string;
  issuer: 'ASDC';
  classroomId: string;
  generatedAt: string;
  generatedBy: string;
  qrPayload: ClassroomQRPayload;
}

export interface StudentAttendanceSummary {
  totalClassesScheduled: number;
  presentCount: number;
  absentCount: number;
  excusedCount: number;
  attendancePercentage: number;
}

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

