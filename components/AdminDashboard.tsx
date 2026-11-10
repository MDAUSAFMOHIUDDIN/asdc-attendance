'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Users,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  Download,
  Printer,
  Calendar,
  Plus,
  Trash2,
  Edit,
  Shield,
  FileSpreadsheet,
  Bell,
  RefreshCw,
  LogOut,
  Sliders,
  QrCode,
  CheckCheck,
  AlertTriangle,
  AlertCircle,
  ExternalLink,
  Info,
  Check,
  MapPin,
  MapPinOff,
  Navigation,
  Crosshair,
  Radio,
} from 'lucide-react';
import {
  getAllStudents,
  getAttendanceRecordsForDate,
  getHolidays,
  getAnnouncements,
  getAuditLogs,
  correctAttendanceRecord,
  saveHoliday,
  removeHoliday,
  createAnnouncement,
  deleteAnnouncement,
  getStudentAttendanceRecords,
  fetchMasterWorkbookInfo,
  fetchMasterAttendanceForDate,
  finalizeMasterDailyAttendance,
  correctMasterAttendanceEntry,
  triggerMasterWorkbookDownload,
} from '@/lib/attendance-service';
import { db } from '@/lib/firebase';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
} from 'firebase/firestore';
import {
  StudentProfile,
  AttendanceRecord,
  Holiday,
  Announcement,
  AuditLog,
  AttendanceStatus,
  MasterWorkbookInfo,
  DateAttendanceRecord,
  ExcelStudentRow,
  ActiveQRChallenge,
  GeofenceConfig,
  LocationIncident,
  QRAccessStatus,
} from '@/lib/types';
import {
  getISTTimeInfo,
  formatDisplayDate,
  formatDisplayTimestamp,
  checkAttendanceWindow,
} from '@/lib/date-utils';
import {
  SOLE_ADMIN_EMAIL,
  INSTITUTE_CONFIG,
} from '@/lib/admin-config';
import { generateClassroomQRDataUrl } from '@/lib/qr-generator';

interface AdminDashboardProps {
  adminEmail: string;
  onLogout: () => void;
}

export function AdminDashboard({ adminEmail, onLogout }: AdminDashboardProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'excel' | 'qr' | 'holidays' | 'announcements' | 'audit' | 'settings'>('overview');

  // Core Data
  const [students, setStudents] = useState<StudentProfile[]>([]);
  const [holidays, setHolidays] = useState<Record<string, Holiday>>({});
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  // Master Excel Canonical Workbook State
  const [masterInfo, setMasterInfo] = useState<MasterWorkbookInfo | null>(null);
  const [masterDailyData, setMasterDailyData] = useState<{
    date: string;
    column: string | null;
    weekday: string;
    presentCount: number;
    absentCount: number;
    unmarkedCount: number;
    records: DateAttendanceRecord[];
  } | null>(null);
  const [loadingMaster, setLoadingMaster] = useState(false);
  const [finalizingModalOpen, setFinalizingModalOpen] = useState(false);
  const [finalizingSubmitting, setFinalizingSubmitting] = useState(false);
  const [masterCorrectionModal, setMasterCorrectionModal] = useState<{
    row: number;
    studentName: string;
    currentStatus: 'P' | 'A' | 'L' | null;
    date: string;
    cellRef: string;
  } | null>(null);
  const [masterCorrectionStatus, setMasterCorrectionStatus] = useState<'P' | 'A' | 'L' | ''>('P');
  const [masterCorrectionReason, setMasterCorrectionReason] = useState('');
  const [masterCorrectionSubmitting, setMasterCorrectionSubmitting] = useState(false);
  const [masterFeedback, setMasterFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Selected Date Filter for Attendance
  const todayIST = getISTTimeInfo();
  const [selectedDate, setSelectedDate] = useState<string>(todayIST.dateString);
  const [dailyAttendance, setDailyAttendance] = useState<Record<string, AttendanceRecord>>({});
  const [loadingAttendance, setLoadingAttendance] = useState(false);

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PRESENT' | 'ABSENT' | 'NOT_RECORDED'>('ALL');

  // Modals & Actions
  const [selectedStudentForDetail, setSelectedStudentForDetail] = useState<StudentProfile | null>(null);
  const [studentDetailRecords, setStudentDetailRecords] = useState<AttendanceRecord[]>([]);
  const [correctionModalStudent, setCorrectionModalStudent] = useState<StudentProfile | null>(null);
  const [correctionStatus, setCorrectionStatus] = useState<AttendanceStatus>('PRESENT');
  const [correctionReason, setCorrectionReason] = useState('');
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);

  // Printable QR state - initialize origin synchronously from window
  const [currentAppOrigin] = useState<string>(() => {
    return typeof window !== 'undefined' ? window.location.origin : '';
  });
  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  // Feature 1: Permanent Classroom QR & Admin Access ON/OFF Control
  const [activeQRChallenge, setActiveQRChallenge] = useState<ActiveQRChallenge | null>(null);
  const [qrAccessStatus, setQrAccessStatus] = useState<QRAccessStatus>('ENABLED');
  const [isTogglingQRAccess, setIsTogglingQRAccess] = useState<boolean>(false);
  const [qrSuccessMessage, setQrSuccessMessage] = useState<string | null>(null);
  const [qrErrorMessage, setQrErrorMessage] = useState<string | null>(null);

  // File Download State
  const [downloadingExcel, setDownloadingExcel] = useState<boolean>(false);

  // Feature 2: Geofence Configuration State
  const [geofenceConfig, setGeofenceConfig] = useState<GeofenceConfig | null>(null);
  const [geofenceRadiusInput, setGeofenceRadiusInput] = useState<number>(100);
  const [geofenceAccuracyInput, setGeofenceAccuracyInput] = useState<number>(50);
  const [isSavingGeofence, setIsSavingGeofence] = useState<boolean>(false);
  const [geofenceSuccessMessage, setGeofenceSuccessMessage] = useState<string | null>(null);
  const [geofenceErrorMessage, setGeofenceErrorMessage] = useState<string | null>(null);

  // Feature 2: Location Security Alerts
  const [locationIncidents, setLocationIncidents] = useState<LocationIncident[]>([]);
  const [isLoadingIncidents, setIsLoadingIncidents] = useState<boolean>(false);
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'unreviewed' | 'OUTSIDE_GEOFENCE' | 'INVALID_QR_CHALLENGE'>('all');
  const [reviewingIncidentId, setReviewingIncidentId] = useState<string | null>(null);

  // Holiday Form
  const [holidayDate, setHolidayDate] = useState('');
  const [holidayTitle, setHolidayTitle] = useState('');
  const [holidayReason, setHolidayReason] = useState('');
  const [holidaySubmitting, setHolidaySubmitting] = useState(false);

  // Announcement Form
  const [annTitle, setAnnTitle] = useState('');
  const [annMessage, setAnnMessage] = useState('');
  const [annCategory, setAnnCategory] = useState<'GENERAL' | 'HOLIDAY' | 'SCHEDULE' | 'URGENT'>('GENERAL');
  const [annSubmitting, setAnnSubmitting] = useState(false);

  // Boundary test state
  const [testResult, setTestResult] = useState<any>(null);
  const [testingBoundary, setTestingBoundary] = useState(false);

  // Live IST Clock
  const [liveIstTime, setLiveIstTime] = useState<string>('');
  const [windowStatus, setWindowStatus] = useState(checkAttendanceWindow());

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const ist = getISTTimeInfo(now);
      setLiveIstTime(`${ist.timeString} IST`);
      setWindowStatus(checkAttendanceWindow(now));
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const loadActiveQR = useCallback(async () => {
    try {
      const res = await fetch(`/api/attendance/qr/active?adminEmail=${encodeURIComponent(adminEmail)}`);
      const data = await res.json();
      if (data.success) {
        if (data.challenge) setActiveQRChallenge(data.challenge);
        if (data.qrDataUrl) setQrDataUrl(data.qrDataUrl);
        if (data.qrAccessStatus) setQrAccessStatus(data.qrAccessStatus);
      }
    } catch (err) {
      console.error('Failed to load active QR:', err);
    }
  }, [adminEmail]);

  const handleToggleQRAccess = async (newStatus: QRAccessStatus) => {
    try {
      setIsTogglingQRAccess(true);
      setQrErrorMessage(null);
      const res = await fetch('/api/attendance/qr/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail, status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update QR access state.');
      }
      setQrAccessStatus(newStatus);
      setQrSuccessMessage(`Classroom QR Access successfully ${newStatus}!`);
      setTimeout(() => setQrSuccessMessage(null), 5000);
    } catch (err: any) {
      setQrErrorMessage(err.message || 'Error updating QR access');
    } finally {
      setIsTogglingQRAccess(false);
    }
  };

  const loadGeofenceConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/attendance/geofence/config');
      const data = await res.json();
      if (data.success && data.config) {
        setGeofenceConfig(data.config);
        setGeofenceRadiusInput(data.config.radiusMeters || 2000);
        setGeofenceAccuracyInput(data.config.maxAccuracyMeters || 50);
      }
    } catch (err) {
      console.error('Failed to load geofence config:', err);
    }
  }, []);

  const handleSaveGeofence = async () => {
    try {
      setIsSavingGeofence(true);
      setGeofenceErrorMessage(null);
      const res = await fetch('/api/attendance/geofence/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminEmail,
          radiusMeters: Number(geofenceRadiusInput),
          maxAccuracyMeters: Number(geofenceAccuracyInput),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update geofence');
      }
      setGeofenceConfig(data.config);
      setGeofenceSuccessMessage('Institute geofence configuration updated.');
      setTimeout(() => setGeofenceSuccessMessage(null), 4000);
    } catch (err: any) {
      setGeofenceErrorMessage(err.message || 'Failed to update geofence');
    } finally {
      setIsSavingGeofence(false);
    }
  };

  const loadLocationIncidents = useCallback(async () => {
    try {
      setIsLoadingIncidents(true);
      const res = await fetch(`/api/attendance/incidents?adminEmail=${encodeURIComponent(adminEmail)}`);
      const data = await res.json();
      if (data.success && data.incidents) {
        setLocationIncidents(data.incidents);
      }
    } catch (err) {
      console.error('Failed to load location incidents:', err);
    } finally {
      setIsLoadingIncidents(false);
    }
  }, [adminEmail]);

  const handleReviewIncident = async (incidentId: string) => {
    try {
      setReviewingIncidentId(incidentId);

      // Optimistic update
      setLocationIncidents((prev) =>
        prev.map((inc) =>
          inc.id === incidentId
            ? { ...inc, status: 'Reviewed', reviewedAt: new Date().toISOString(), reviewedBy: adminEmail }
            : inc
        )
      );

      // Direct Firestore update
      try {
        const docRef = doc(db, 'location_incidents', incidentId);
        await updateDoc(docRef, {
          status: 'Reviewed',
          reviewedAt: new Date().toISOString(),
          reviewedBy: adminEmail,
        });
      } catch (fsErr) {
        console.warn('Firestore direct review update note:', fsErr);
      }

      const res = await fetch('/api/attendance/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminEmail, incidentId, action: 'review' }),
      });
      const data = await res.json();
      if (data.success && data.incidents) {
        setLocationIncidents(data.incidents);
      }
    } catch (err) {
      console.error('Failed to review incident:', err);
    } finally {
      setReviewingIncidentId(null);
    }
  };

  // Real-Time Database Listener: Location Security Alerts
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const q = query(
        collection(db, 'location_incidents'),
        orderBy('timestamp', 'desc')
      );
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const items: LocationIncident[] = [];
          snapshot.forEach((docSnap) => {
            items.push({ id: docSnap.id, ...docSnap.data() } as LocationIncident);
          });
          setLocationIncidents(items);
          setIsLoadingIncidents(false);
        },
        (error) => {
          console.warn('Real-time incidents listener fallback to polling:', error);
          loadLocationIncidents();
        }
      );
    } catch (err) {
      console.warn('Could not initialize real-time listener:', err);
      loadLocationIncidents();
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [adminEmail, loadLocationIncidents]);

  // Real-Time Database Listener: Classroom QR Access ON/OFF state
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const docRef = doc(db, 'settings', 'qr_access');
      unsubscribe = onSnapshot(
        docRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            if (data?.status === 'ENABLED' || data?.status === 'DISABLED') {
              setQrAccessStatus(data.status);
            }
          }
        },
        (err) => console.warn('QR access listener note:', err)
      );
    } catch (err) {
      console.warn('Could not initialize QR access listener:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    loadActiveQR();
    loadGeofenceConfig();
    loadLocationIncidents();
  }, [loadActiveQR, loadGeofenceConfig, loadLocationIncidents]);

  const unreviewedIncidentsCount = useMemo(
    () => locationIncidents.filter((i) => i.status === 'New').length,
    [locationIncidents]
  );

  const loadAllData = useCallback(async () => {
    try {
      const [stuList, holMap, annList, logList] = await Promise.all([
        getAllStudents(),
        getHolidays(),
        getAnnouncements(),
        getAuditLogs(),
      ]);
      setStudents(stuList);
      setHolidays(holMap);
      setAnnouncements(annList);
      setAuditLogs(logList);
    } catch (err) {
      console.error('Error fetching admin data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAttendanceForSelectedDate = useCallback(async (date: string) => {
    try {
      setLoadingAttendance(true);
      const map = await getAttendanceRecordsForDate(date);
      setDailyAttendance(map);
    } catch (err) {
      console.error('Failed to load attendance for date:', err);
    } finally {
      setLoadingAttendance(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    Promise.all([
      getAllStudents(),
      getHolidays(),
      getAnnouncements(),
      getAuditLogs(),
    ]).then(([stuList, holMap, annList, logList]) => {
      if (isMounted) {
        setStudents(stuList);
        setHolidays(holMap);
        setAnnouncements(annList);
        setAuditLogs(logList);
        setLoading(false);
      }
    }).catch(console.error);

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    if (selectedDate) {
      getAttendanceRecordsForDate(selectedDate).then((map) => {
        if (isMounted) {
          setDailyAttendance(map);
          setLoadingAttendance(false);
        }
      }).catch(console.error);
    }
    return () => {
      isMounted = false;
    };
  }, [selectedDate]);

  // Master Workbook Data Loader
  const loadMasterData = useCallback(async (targetDate = selectedDate) => {
    try {
      setLoadingMaster(true);
      const [info, daily] = await Promise.all([
        fetchMasterWorkbookInfo(adminEmail),
        fetchMasterAttendanceForDate(adminEmail, targetDate),
      ]);
      setMasterInfo(info);
      setMasterDailyData(daily);
    } catch (err) {
      console.error('Failed to load master workbook data:', err);
    } finally {
      setLoadingMaster(false);
    }
  }, [adminEmail, selectedDate]);

  useEffect(() => {
    loadMasterData(selectedDate);
  }, [selectedDate, loadMasterData]);

  // Master Workbook Handlers
  const handleDownloadMasterExcel = async () => {
    try {
      setDownloadingExcel(true);
      setMasterFeedback(null);
      await triggerMasterWorkbookDownload(adminEmail);
      setMasterFeedback({
        type: 'success',
        message: 'Master Excel register (B-19-AI Builder (1) (3).xlsx) downloaded successfully.',
      });
    } catch (err: any) {
      console.error('Master Excel download error:', err);
      const msg = err?.message || 'Failed to download master Excel workbook.';
      setMasterFeedback({
        type: 'error',
        message: msg,
      });
      alert(msg);
    } finally {
      setDownloadingExcel(false);
    }
  };

  const handleConfirmFinalize = async () => {
    try {
      setFinalizingSubmitting(true);
      setMasterFeedback(null);
      const res = await finalizeMasterDailyAttendance(adminEmail, selectedDate);
      setFinalizingModalOpen(false);
      setMasterFeedback({
        type: 'success',
        message: res.message || `Successfully finalized daily attendance for ${selectedDate}.`,
      });
      await Promise.all([
        loadMasterData(selectedDate),
        loadAttendanceForSelectedDate(selectedDate),
      ]);
    } catch (err) {
      setMasterFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Finalization failed.',
      });
    } finally {
      setFinalizingSubmitting(false);
    }
  };

  const handleConfirmMasterCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!masterCorrectionModal) return;
    if (masterCorrectionReason.trim().length < 5) {
      alert('Mandatory audit reason must be at least 5 characters.');
      return;
    }
    try {
      setMasterCorrectionSubmitting(true);
      setMasterFeedback(null);
      const res = await correctMasterAttendanceEntry({
        adminEmail,
        row: masterCorrectionModal.row,
        date: masterCorrectionModal.date,
        newStatus: masterCorrectionStatus,
        reason: masterCorrectionReason.trim(),
      });
      setMasterCorrectionModal(null);
      setMasterFeedback({
        type: 'success',
        message: res.message || 'Attendance entry corrected in Master Excel register.',
      });
      await Promise.all([
        loadMasterData(masterCorrectionModal.date),
        loadAttendanceForSelectedDate(masterCorrectionModal.date),
      ]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Correction failed.');
    } finally {
      setMasterCorrectionSubmitting(false);
    }
  };

  // Handle student detail view
  const handleOpenStudentDetail = async (stu: StudentProfile) => {
    setSelectedStudentForDetail(stu);
    try {
      const recs = await getStudentAttendanceRecords(stu.uid);
      setStudentDetailRecords(recs);
    } catch (err) {
      console.error('Failed to load student history:', err);
    }
  };

  // Check status for a student on selectedDate
  const getStudentStatusForDate = useCallback(
    (stuUid: string): {
      status: 'PRESENT' | 'ABSENT' | 'EXCUSED' | 'NOT_RECORDED' | 'HOLIDAY';
      record?: AttendanceRecord;
    } => {
      const isHoliday = Boolean(holidays[selectedDate]);
      if (isHoliday) {
        return { status: 'HOLIDAY' };
      }

      const rec = dailyAttendance[stuUid];
      if (rec) {
        return { status: rec.status, record: rec };
      }

      const isToday = selectedDate === todayIST.dateString;
      if (isToday) {
        return { status: 'NOT_RECORDED' };
      }

      // Past date with no record
      return { status: 'ABSENT' };
    },
    [dailyAttendance, holidays, selectedDate, todayIST.dateString]
  );

  // Filter students based on search and status
  const filteredStudents = useMemo(() => {
    return students.filter((stu) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        stu.fullName.toLowerCase().includes(q) ||
        stu.studentId.toLowerCase().includes(q) ||
        stu.phoneNumber.includes(q) ||
        stu.email.toLowerCase().includes(q);

      if (!matchesSearch) return false;

      if (statusFilter === 'ALL') return true;
      const { status } = getStudentStatusForDate(stu.uid);
      if (statusFilter === 'PRESENT') return status === 'PRESENT';
      if (statusFilter === 'ABSENT') return status === 'ABSENT';
      if (statusFilter === 'NOT_RECORDED') return status === 'NOT_RECORDED';

      return true;
    });
  }, [students, searchQuery, statusFilter, getStudentStatusForDate]);

  // Aggregate Metrics for Selected Date
  const metrics = useMemo(() => {
    let present = 0;
    let absent = 0;
    let notFinalized = 0;
    const isHoliday = Boolean(holidays[selectedDate]);

    students.forEach((stu) => {
      const { status } = getStudentStatusForDate(stu.uid);
      if (status === 'PRESENT') present++;
      else if (status === 'ABSENT') absent++;
      else if (status === 'NOT_RECORDED') notFinalized++;
    });

    return {
      totalStudents: students.length,
      present,
      absent,
      notFinalized,
      isHoliday,
    };
  }, [students, selectedDate, holidays, getStudentStatusForDate]);

  // Handle Attendance Correction Submission
  const handleSaveCorrection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!correctionModalStudent) return;
    setCorrectionSubmitting(true);

    try {
      await correctAttendanceRecord({
        adminEmail,
        student: correctionModalStudent,
        classDate: selectedDate,
        newStatus: correctionStatus,
        reason: correctionReason,
      });

      await loadAttendanceForSelectedDate(selectedDate);
      const updatedLogs = await getAuditLogs();
      setAuditLogs(updatedLogs);

      setCorrectionModalStudent(null);
      setCorrectionReason('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Correction failed.');
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  // Handle Holiday Add
  const handleAddHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!holidayDate || !holidayTitle.trim()) return;
    setHolidaySubmitting(true);
    try {
      await saveHoliday({
        date: holidayDate,
        title: holidayTitle,
        reason: holidayReason,
        adminEmail,
      });
      const holMap = await getHolidays();
      setHolidays(holMap);
      setHolidayDate('');
      setHolidayTitle('');
      setHolidayReason('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add holiday.');
    } finally {
      setHolidaySubmitting(false);
    }
  };

  const handleRemoveHoliday = async (date: string) => {
    if (!confirm(`Are you sure you want to remove holiday for ${date}?`)) return;
    try {
      await removeHoliday(date);
      const holMap = await getHolidays();
      setHolidays(holMap);
    } catch (err) {
      alert('Failed to remove holiday');
    }
  };

  // Handle Announcement Add
  const handleCreateAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!annTitle.trim() || !annMessage.trim()) return;
    setAnnSubmitting(true);
    try {
      await createAnnouncement({
        title: annTitle,
        message: annMessage,
        category: annCategory,
        adminEmail,
      });
      const annList = await getAnnouncements();
      setAnnouncements(annList);
      setAnnTitle('');
      setAnnMessage('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish announcement.');
    } finally {
      setAnnSubmitting(false);
    }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    if (!confirm('Delete this announcement?')) return;
    try {
      await deleteAnnouncement(id);
      const annList = await getAnnouncements();
      setAnnouncements(annList);
    } catch (err) {
      alert('Failed to delete announcement');
    }
  };

  // CSV Export
  const exportAttendanceCSV = () => {
    if (students.length === 0) {
      alert('No students to export.');
      return;
    }

    const headers = [
      'Student ID',
      'Full Name',
      'Email',
      'Mobile Phone',
      'Batch',
      `Status (${selectedDate})`,
      'Submission Source',
      'Timestamp (IST)',
      'Correction Reason',
    ];

    const rows = students.map((stu) => {
      const { status, record } = getStudentStatusForDate(stu.uid);
      return [
        stu.studentId,
        `"${stu.fullName.replace(/"/g, '""')}"`,
        stu.email,
        stu.phoneNumber,
        `"${stu.batchName}"`,
        status,
        record?.source || '-',
        record ? `"${formatDisplayTimestamp(record.verifiedAt)}"` : '-',
        record?.correctionReason ? `"${record.correctionReason.replace(/"/g, '""')}"` : '-',
      ];
    });

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    // Prepend UTF-8 BOM (\uFEFF) for 100% correct encoding in Microsoft Excel
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `ASDC_Attendance_${selectedDate}.csv`);
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 1000);
  };

  // Run Boundary Tests
  const runBoundaryTests = async () => {
    setTestingBoundary(true);
    try {
      const res = await fetch('/api/attendance/test-boundary');
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      alert('Failed to run boundary tests');
    } finally {
      setTestingBoundary(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col pb-16 selection:bg-blue-600 selection:text-white">
      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center font-black tracking-wider text-white shadow-sm shadow-blue-500/20">
              AS
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-950 text-base tracking-tight">
                  {INSTITUTE_CONFIG.INSTITUTE_FULL_NAME}
                </span>
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                  Sole Admin Master
                </span>
              </div>
              <p className="text-xs text-slate-500">Institutional Administration & Audit</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live IST indicator */}
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-700">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold">{liveIstTime || 'Connecting...'}</span>
            </div>

            <div className="text-right hidden sm:block">
              <span className="text-xs font-bold text-slate-900 block truncate max-w-[200px]">
                {adminEmail}
              </span>
              <span className="text-[10px] text-blue-700 font-semibold">Sole Authorized Administrator</span>
            </div>

            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition border border-slate-200"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex overflow-x-auto border-t border-slate-200 gap-1 py-1.5 scrollbar-none text-xs font-semibold">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'overview'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            Attendance & Students
          </button>
          <button
            onClick={() => setActiveTab('excel')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'excel'
                ? 'bg-emerald-700 text-white shadow-sm'
                : 'text-slate-700 hover:text-slate-950 hover:bg-emerald-50'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" />
            Official Excel Register
            {masterInfo && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold ml-1 border border-emerald-200">
                v{masterInfo.version}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('qr')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'qr'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" />
            QR & Geofence Security
            {unreviewedIncidentsCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-rose-500 text-white font-black text-[10px] animate-pulse">
                {unreviewedIncidentsCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('holidays')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'holidays'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            Holidays & Schedule ({Object.keys(holidays).length})
          </button>
          <button
            onClick={() => setActiveTab('announcements')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'announcements'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            Announcements ({announcements.length})
          </button>
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'audit'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            Audit Logs ({auditLogs.length})
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-3.5 py-2 rounded-lg transition whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'settings'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            Settings & Pilot Tests
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-6 flex-1">
        {/* ===================== TAB 1: OVERVIEW & ATTENDANCE ===================== */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Top Toolbar: Date Picker & Actions */}
            <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-blue-600" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Report Date (IST):
                  </span>
                </div>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {selectedDate === todayIST.dateString && (
                  <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                    Today
                  </span>
                )}
                {metrics.isHoliday && (
                  <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200">
                    Holiday: {holidays[selectedDate]?.title}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    loadAllData();
                    loadAttendanceForSelectedDate(selectedDate);
                  }}
                  className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-bold flex items-center gap-1.5 transition border border-slate-200"
                  title="Refresh records"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
                <button
                  onClick={() => setFinalizingModalOpen(true)}
                  className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                  title="Finalize absences for unrecorded students"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  Finalize Daily Attendance
                </button>
                <button
                  onClick={handleDownloadMasterExcel}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                  title="Download Official Master Excel Workbook"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download Master Excel
                </button>
              </div>
            </div>

            {/* Official Master Excel Banner */}
            <div className="bg-gradient-to-r from-emerald-50 via-teal-50 to-blue-50 border border-emerald-200/80 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="p-2.5 bg-emerald-600 text-white rounded-xl shadow-sm mt-0.5">
                  <FileSpreadsheet className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-bold text-slate-950">
                      Official Excel Register: {masterInfo?.workbookName || 'B-19-AI Builder (1) (3).xlsx'}
                    </h3>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300">
                      Revision v{masterInfo?.version || 1}
                    </span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300">
                      Batch-19 Canonical
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    Synchronized with institute master workbook • Selected Date Column:{' '}
                    <strong className="text-slate-900 font-mono">
                      {masterDailyData?.column ? `Column ${masterDailyData.column} (${selectedDate})` : `${selectedDate}`}
                    </strong>
                    {masterDailyData && ` • ${masterDailyData.presentCount} Present, ${masterDailyData.absentCount} Absent, ${masterDailyData.unmarkedCount} Unmarked`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setActiveTab('excel')}
                  className="px-3.5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  View Full Register
                </button>
                <button
                  onClick={handleDownloadMasterExcel}
                  className="px-3 py-2 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  Download
                </button>
              </div>
            </div>

            {/* Summary Metrics Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
                  Total Students
                </span>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl sm:text-3xl font-extrabold text-slate-950">
                    {metrics.totalStudents}
                  </span>
                  <Users className="w-5 h-5 text-blue-600" />
                </div>
                <span className="text-[11px] text-slate-500 mt-2 block font-medium">
                  Enrolled in {INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}
                </span>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
                  Present on Date
                </span>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl sm:text-3xl font-extrabold text-emerald-700">
                    {metrics.present}
                  </span>
                  <CheckCircle className="w-5 h-5 text-emerald-600" />
                </div>
                <span className="text-[11px] text-slate-500 mt-2 block font-medium">
                  {metrics.totalStudents > 0
                    ? `${Math.round((metrics.present / metrics.totalStudents) * 100)}% attendance rate`
                    : 'No students enrolled'}
                </span>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
                  Absent on Date
                </span>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl sm:text-3xl font-extrabold text-rose-700">
                    {metrics.absent}
                  </span>
                  <XCircle className="w-5 h-5 text-rose-600" />
                </div>
                <span className="text-[11px] text-slate-500 mt-2 block font-medium">
                  {metrics.isHoliday
                    ? 'No absences on declared holidays'
                    : selectedDate === todayIST.dateString
                    ? 'Attendance open anytime today'
                    : 'Unrecorded / Past Absent'}
                </span>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 shadow-sm">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block mb-1">
                  Pending / Open
                </span>
                <div className="flex items-baseline justify-between">
                  <span className="text-2xl sm:text-3xl font-extrabold text-amber-600">
                    {metrics.notFinalized}
                  </span>
                  <Clock className="w-5 h-5 text-amber-500" />
                </div>
                <span className="text-[11px] text-slate-500 mt-2 block font-medium">
                  {selectedDate === todayIST.dateString
                    ? 'Open for scanning 24/7'
                    : 'Past dates resolved'}
                </span>
              </div>
            </div>

            {/* Students Table Section */}
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
              {/* Filter controls */}
              <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search by name, ID (ASDC-0001), phone, or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-3.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
                  />
                </div>

                <div className="flex items-center gap-1 text-xs">
                  <span className="text-slate-600 font-bold text-[11px] mr-1 hidden sm:inline">Status:</span>
                  {(['ALL', 'PRESENT', 'ABSENT', 'NOT_RECORDED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`px-3 py-1 rounded-md text-[11px] font-bold transition ${
                        statusFilter === s
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {s === 'ALL'
                        ? 'All'
                        : s === 'PRESENT'
                        ? 'Present'
                        : s === 'ABSENT'
                        ? 'Absent'
                        : 'Pending'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                {loading || loadingAttendance ? (
                  <div className="p-12 text-center text-xs text-slate-600 flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span>Loading student registry & attendance...</span>
                  </div>
                ) : filteredStudents.length === 0 ? (
                  <div className="p-12 text-center text-xs text-slate-500 font-medium">
                    {students.length === 0
                      ? 'No students registered in ASDC yet. Provide the app URL to students to register.'
                      : 'No students match the current filter or search criteria.'}
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 uppercase tracking-wider font-bold text-[11px]">
                        <th className="px-4 py-3">Student ID</th>
                        <th className="px-4 py-3">Student Name</th>
                        <th className="px-4 py-3">Contact (Phone & Gmail)</th>
                        <th className="px-4 py-3">Date Status ({selectedDate})</th>
                        <th className="px-4 py-3">Source / Remark</th>
                        <th className="px-4 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredStudents.map((stu) => {
                        const { status, record } = getStudentStatusForDate(stu.uid);
                        return (
                          <tr key={stu.uid} className="hover:bg-slate-50 transition">
                            <td className="px-4 py-3 font-mono font-bold text-blue-700">
                              {stu.studentId}
                            </td>
                            <td className="px-4 py-3 font-bold text-slate-950">
                              {stu.fullName}
                            </td>
                            <td className="px-4 py-3 text-slate-600 font-medium">
                              <div>+91 {stu.phoneNumber}</div>
                              <div className="text-[11px] text-slate-500 font-mono">{stu.email}</div>
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md font-bold text-[11px] ${
                                  status === 'PRESENT'
                                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                                    : status === 'HOLIDAY'
                                    ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                    : status === 'NOT_RECORDED'
                                    ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                    : status === 'EXCUSED'
                                    ? 'bg-blue-100 text-blue-800 border border-blue-200'
                                    : 'bg-rose-100 text-rose-800 border border-rose-200'
                                }`}
                              >
                                {status === 'PRESENT' ? (
                                  <CheckCircle className="w-3 h-3 text-emerald-700" />
                                ) : status === 'HOLIDAY' ? (
                                  <Calendar className="w-3 h-3 text-purple-700" />
                                ) : status === 'NOT_RECORDED' ? (
                                  <Clock className="w-3 h-3 text-amber-700" />
                                ) : (
                                  <XCircle className="w-3 h-3 text-rose-700" />
                                )}
                                {status === 'NOT_RECORDED' ? 'Open / Pending' : status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-slate-600 font-medium">
                              {record?.source === 'QR_SCAN' ? (
                                <span className="text-emerald-700 font-semibold">QR Scan ({formatDisplayTimestamp(record.verifiedAt).split('at')[1] || ''})</span>
                              ) : record?.correctionReason ? (
                                <span className="text-amber-800 truncate max-w-[140px] block" title={record.correctionReason}>
                                  Manual: {record.correctionReason}
                                </span>
                              ) : (
                                '-'
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => handleOpenStudentDetail(stu)}
                                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 rounded text-xs font-semibold transition"
                                >
                                  View
                                </button>
                                <button
                                  onClick={() => {
                                    setCorrectionModalStudent(stu);
                                    setCorrectionStatus(status === 'PRESENT' ? 'ABSENT' : 'PRESENT');
                                    setCorrectionReason('');
                                  }}
                                  className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded text-xs font-bold transition"
                                  title="Correct / Override Attendance"
                                >
                                  <Edit className="w-3 h-3" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================== TAB 2: OFFICIAL EXCEL ATTENDANCE REGISTER ===================== */}
        {activeTab === 'excel' && (
          <div className="space-y-6 animate-fadeIn">
            {/* Top Overview & Master Status Banner */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-sm">
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-100">
                <div className="flex items-start gap-3.5">
                  <div className="p-3 bg-emerald-600 text-white rounded-2xl shadow-sm">
                    <FileSpreadsheet className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-extrabold text-slate-950 tracking-tight">
                        Official Excel Attendance Register
                      </h2>
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300">
                        Revision v{masterInfo?.version || 1}
                      </span>
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800 border border-blue-200">
                        {masterInfo?.batchName || 'BATCH-19 (AI Builder)'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Canonical Workbook: <strong className="font-mono text-slate-800">{masterInfo?.workbookName || 'B-19-AI Builder (1) (3).xlsx'}</strong> • Sheet: <span className="font-medium">{masterInfo?.worksheetName || 'B-19-AI Builder'}</span>
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    onClick={() => loadMasterData(selectedDate)}
                    disabled={loadingMaster}
                    className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold flex items-center gap-1.5 transition border border-slate-200"
                    title="Reload Master Register Data"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingMaster ? 'animate-spin' : ''}`} />
                    Refresh
                  </button>

                  <button
                    onClick={() => setFinalizingModalOpen(true)}
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold flex items-center gap-2 shadow-sm transition"
                    title="Mark unrecorded students as Absent for selected date"
                  >
                    <CheckCheck className="w-4 h-4" />
                    Finalize Daily Attendance
                  </button>

                  <button
                    onClick={handleDownloadMasterExcel}
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-bold flex items-center gap-2 shadow-md transition"
                    title="Download canonical master .xlsx file"
                  >
                    <Download className="w-4 h-4" />
                    Download Latest Master Excel
                  </button>
                </div>
              </div>

              {/* Status Metadata Bar */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 text-xs">
                <div>
                  <span className="text-slate-400 block text-[11px] font-bold uppercase tracking-wider">Sync Status</span>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="font-extrabold text-emerald-800">
                      {masterInfo?.syncStatus === 'ERROR' ? 'Needs Attention' : 'Synchronized & Persistent'}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] font-bold uppercase tracking-wider">Last Master Sync</span>
                  <span className="font-semibold text-slate-800 mt-0.5 block">
                    {masterInfo?.lastSyncedAt ? formatDisplayTimestamp(masterInfo.lastSyncedAt) : 'Ready'}
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] font-bold uppercase tracking-wider">Total Enrolled</span>
                  <span className="font-extrabold text-slate-900 mt-0.5 block">
                    {masterInfo?.totalStudents || 24} Verified Students
                  </span>
                </div>

                <div>
                  <span className="text-slate-400 block text-[11px] font-bold uppercase tracking-wider">Calendar Bounds</span>
                  <span className="font-mono text-slate-700 mt-0.5 block">
                    {masterInfo?.startDate} → {masterInfo?.endDate}
                  </span>
                </div>
              </div>
            </div>

            {/* Notification Feedback Toast */}
            {masterFeedback && (
              <div
                className={`p-4 rounded-xl text-xs font-medium flex items-center justify-between border ${
                  masterFeedback.type === 'success'
                    ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                    : 'bg-rose-50 text-rose-900 border-rose-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  {masterFeedback.type === 'success' ? (
                    <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  )}
                  <span>{masterFeedback.message}</span>
                </div>
                <button
                  onClick={() => setMasterFeedback(null)}
                  className="text-slate-400 hover:text-slate-700 text-xs font-bold px-2 py-0.5"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Selected Date Inspector & Quick Actions */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-emerald-700" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      Attendance Date:
                    </span>
                  </div>
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  {selectedDate === todayIST.dateString && (
                    <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 border border-blue-200">
                      Today ({liveIstTime})
                    </span>
                  )}
                  {masterDailyData?.column && (
                    <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                      Mapped to Column {masterDailyData.column} ({masterDailyData.weekday})
                    </span>
                  )}
                </div>

                {/* Quick Date Navigation */}
                <div className="flex items-center gap-1.5 text-xs">
                  <button
                    onClick={() => {
                      const d = new Date(selectedDate);
                      d.setDate(d.getDate() - 1);
                      const prevStr = d.toISOString().split('T')[0];
                      setSelectedDate(prevStr);
                    }}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200"
                  >
                    ← Previous Day
                  </button>
                  <button
                    onClick={() => setSelectedDate(todayIST.dateString)}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200"
                  >
                    Today
                  </button>
                  <button
                    onClick={() => {
                      const d = new Date(selectedDate);
                      d.setDate(d.getDate() + 1);
                      const nextStr = d.toISOString().split('T')[0];
                      setSelectedDate(nextStr);
                    }}
                    className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold border border-slate-200"
                  >
                    Next Day →
                  </button>
                </div>
              </div>

              {/* Date Attendance Metrics Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block">
                    Total Students
                  </span>
                  <span className="text-2xl font-extrabold text-slate-900 mt-1 block">
                    {masterInfo?.totalStudents || 24}
                  </span>
                  <span className="text-[10px] text-slate-500 block mt-0.5">
                    Official Batch-19 Roster
                  </span>
                </div>

                <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 block">
                    Present (P)
                  </span>
                  <span className="text-2xl font-extrabold text-emerald-700 mt-1 block">
                    {masterDailyData?.presentCount || 0}
                  </span>
                  <span className="text-[10px] text-emerald-700 block mt-0.5">
                    Verified classroom scans
                  </span>
                </div>

                <div className="bg-rose-50/60 border border-rose-200 rounded-xl p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-rose-800 block">
                    Absent (A)
                  </span>
                  <span className="text-2xl font-extrabold text-rose-700 mt-1 block">
                    {masterDailyData?.absentCount || 0}
                  </span>
                  <span className="text-[10px] text-rose-700 block mt-0.5">
                    Confirmed absences
                  </span>
                </div>

                <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-3.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 block">
                    Unmarked
                  </span>
                  <span className="text-2xl font-extrabold text-amber-700 mt-1 block">
                    {masterDailyData?.unmarkedCount || 0}
                  </span>
                  <span className="text-[10px] text-amber-700 block mt-0.5">
                    Pending finalization
                  </span>
                </div>
              </div>
            </div>

            {/* Master Attendance Register Table */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
                <div>
                  <h3 className="text-sm font-bold text-slate-950">
                    Student Register Records ({masterDailyData?.records.length || masterInfo?.students.length || 24} Students)
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Showing status for <strong className="text-slate-800 font-mono">{selectedDate}</strong> (Column {masterDailyData?.column || 'N/A'}) with cumulative totals.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-medium">Status Legend:</span>
                  <span className="px-2 py-0.5 text-[10px] font-extrabold rounded bg-emerald-100 text-emerald-800 border border-emerald-300">
                    P = Present
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-extrabold rounded bg-rose-100 text-rose-800 border border-rose-300">
                    A = Absent
                  </span>
                  <span className="px-2 py-0.5 text-[10px] font-extrabold rounded bg-amber-100 text-amber-800 border border-amber-300">
                    L = Leave
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100/75 text-slate-700 font-bold uppercase text-[11px] tracking-wider border-b border-slate-200">
                    <tr>
                      <th className="py-3 px-3">S.NO</th>
                      <th className="py-3 px-4">Student Name</th>
                      <th className="py-3 px-3">Timing</th>
                      <th className="py-3 px-2 text-center">Total (G)</th>
                      <th className="py-3 px-2 text-center text-emerald-700">P (H)</th>
                      <th className="py-3 px-2 text-center text-rose-700">A (I)</th>
                      <th className="py-3 px-2 text-center text-amber-700">L (J)</th>
                      <th className="py-3 px-3 text-center">Attendance % (K)</th>
                      <th className="py-3 px-4 text-center bg-blue-50/80 text-blue-900 border-x border-blue-200">
                        {selectedDate} Status
                      </th>
                      <th className="py-3 px-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-medium">
                    {(masterDailyData?.records || []).map((rec, idx) => {
                      const studentObj = masterInfo?.students.find((s) => s.row === rec.row);
                      return (
                        <tr key={rec.row} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-3 font-mono text-slate-500">
                            {rec.sno || idx + 1}
                          </td>
                          <td className="py-3 px-4">
                            <span className="font-bold text-slate-900 block">{rec.name}</span>
                            <span className="text-[11px] text-slate-400 font-mono">
                              Row {rec.row} {rec.admissionNo ? `• Adm: ${rec.admissionNo}` : ''}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-slate-600">
                            {studentObj?.timing || 'Evening (5pm to 9pm)'}
                          </td>
                          <td className="py-3 px-2 text-center font-bold text-slate-700">
                            {studentObj?.total ?? 90}
                          </td>
                          <td className="py-3 px-2 text-center font-bold text-emerald-700">
                            {studentObj?.present ?? 0}
                          </td>
                          <td className="py-3 px-2 text-center font-bold text-rose-700">
                            {studentObj?.absent ?? 0}
                          </td>
                          <td className="py-3 px-2 text-center font-bold text-amber-700">
                            {studentObj?.leave ?? 0}
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className="font-bold text-slate-900">
                              {studentObj ? Math.round(studentObj.percentage * 100) : 0}%
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center bg-blue-50/30 border-x border-blue-100">
                            {rec.status === 'P' ? (
                              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300 shadow-xs">
                                <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                                Present (P)
                              </span>
                            ) : rec.status === 'A' ? (
                              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-extrabold bg-rose-100 text-rose-800 border border-rose-300 shadow-xs">
                                <XCircle className="w-3.5 h-3.5 text-rose-600" />
                                Absent (A)
                              </span>
                            ) : rec.status === 'L' ? (
                              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-extrabold bg-amber-100 text-amber-800 border border-amber-300 shadow-xs">
                                Leave (L)
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                                Unmarked
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <button
                              onClick={() => {
                                setMasterCorrectionModal({
                                  row: rec.row,
                                  studentName: rec.name,
                                  currentStatus: rec.status,
                                  date: selectedDate,
                                  cellRef: rec.cellRef,
                                });
                                setMasterCorrectionStatus(rec.status || 'P');
                                setMasterCorrectionReason('');
                              }}
                              className="px-2.5 py-1 text-slate-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg text-xs font-bold transition border border-slate-200 inline-flex items-center gap-1"
                              title="Correct attendance entry in Master Excel"
                            >
                              <Edit className="w-3 h-3" />
                              Correct
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Synchronization & Matching Errors Section */}
            {masterInfo?.errors && masterInfo.errors.length > 0 && (
              <div className="bg-rose-50 border border-rose-200 rounded-2xl p-5 shadow-sm space-y-3">
                <div className="flex items-center gap-2 text-rose-800">
                  <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                  <h4 className="text-sm font-bold">Synchronization & Matching Notices</h4>
                </div>
                <div className="space-y-1.5 text-xs text-rose-700">
                  {masterInfo.errors.map((err, i) => (
                    <div key={i} className="flex items-start gap-2 bg-white/70 p-2.5 rounded-lg border border-rose-200">
                      <span className="font-mono text-rose-500 font-bold">#{i + 1}</span>
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===================== TAB 3: QR CODE & GEOFENCE SECURITY ===================== */}
        {activeTab === 'qr' && (
          <div className="space-y-8 max-w-5xl mx-auto">
            {/* Success & Error Banners */}
            {qrSuccessMessage && (
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-center gap-3 text-emerald-900 text-xs font-semibold animate-fadeIn shadow-sm">
                <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                <span>{qrSuccessMessage}</span>
              </div>
            )}
            {qrErrorMessage && (
              <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-3 text-rose-900 text-xs font-semibold animate-fadeIn shadow-sm">
                <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0" />
                <span>{qrErrorMessage}</span>
              </div>
            )}

            {/* 1. ADMIN CLASSROOM QR ACCESS & PERMANENT QR CODE */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-blue-600 text-white shadow-sm">
                    <QrCode className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-950">Classroom Attendance QR Code</h3>
                    <p className="text-xs text-slate-500 font-medium">
                      One permanent ASDC QR code • Controlled by Administrator ON/OFF access switch
                    </p>
                  </div>
                </div>

                {/* Prominent CLASSROOM QR ACCESS Controls */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleToggleQRAccess('ENABLED')}
                    disabled={isTogglingQRAccess || qrAccessStatus === 'ENABLED'}
                    className={`px-4 py-2.5 rounded-xl font-black text-xs flex items-center gap-2 transition shadow-sm ${
                      qrAccessStatus === 'ENABLED'
                        ? 'bg-emerald-600 text-white cursor-default opacity-90'
                        : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 border border-emerald-300 cursor-pointer active:scale-95'
                    }`}
                  >
                    <CheckCircle className="w-4 h-4" />
                    ENABLE QR ACCESS
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleQRAccess('DISABLED')}
                    disabled={isTogglingQRAccess || qrAccessStatus === 'DISABLED'}
                    className={`px-4 py-2.5 rounded-xl font-black text-xs flex items-center gap-2 transition shadow-sm ${
                      qrAccessStatus === 'DISABLED'
                        ? 'bg-rose-600 text-white cursor-default opacity-90'
                        : 'bg-rose-50 text-rose-800 hover:bg-rose-100 border border-rose-300 cursor-pointer active:scale-95'
                    }`}
                  >
                    <XCircle className="w-4 h-4" />
                    DISABLE QR ACCESS
                  </button>
                </div>
              </div>

              <div className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                {/* QR Access Status & Info Column */}
                <div className="lg:col-span-6 space-y-4">
                  {/* Dedicated CLASSROOM QR ACCESS Status Card */}
                  <div
                    className={`p-5 rounded-2xl border-2 transition ${
                      qrAccessStatus === 'ENABLED'
                        ? 'bg-emerald-50/90 border-emerald-500 text-emerald-950 shadow-sm'
                        : 'bg-rose-50/90 border-rose-500 text-rose-950 shadow-sm'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-black uppercase tracking-wider text-slate-700">
                        CLASSROOM QR ACCESS
                      </span>
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-black tracking-wider flex items-center gap-1.5 shadow-sm ${
                          qrAccessStatus === 'ENABLED'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-rose-600 text-white'
                        }`}
                      >
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            qrAccessStatus === 'ENABLED' ? 'bg-white animate-pulse' : 'bg-white'
                          }`}
                        />
                        {qrAccessStatus}
                      </span>
                    </div>
                    <p className="text-xs font-semibold leading-relaxed">
                      {qrAccessStatus === 'ENABLED'
                        ? 'Attendance submissions are currently ENABLED. Authenticated students within the 2,000m ASDC campus radius can scan the permanent classroom QR to mark attendance.'
                        : 'Attendance is currently DISABLED by the administrator. Any student scan attempt will be safely rejected on the backend without recording attendance.'}
                    </p>
                  </div>

                  {/* Permanent QR Static Token Box */}
                  <div className="p-4 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-mono text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                        <Shield className="w-3.5 h-3.5 text-emerald-400" />
                        Permanent Classroom QR Code
                      </span>
                      <span className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full font-mono">
                        NO Expiration
                      </span>
                    </div>
                    <p className="font-mono text-xs break-all text-emerald-400 font-bold bg-slate-950 p-2.5 rounded-lg border border-slate-800">
                      ASDC_PERMANENT_CLASSROOM_QR
                    </p>
                    <p className="text-[11px] text-slate-400">
                      Institute: <strong className="text-slate-200">{INSTITUTE_CONFIG.INSTITUTE_NAME}</strong> • Authorized Admin:{' '}
                      <strong className="text-slate-200">{SOLE_ADMIN_EMAIL}</strong>
                    </p>
                  </div>

                  {/* Operational Guide */}
                  <div className="p-4 bg-blue-50/70 border border-blue-200 rounded-xl text-xs text-blue-900 space-y-1.5 font-medium">
                    <p className="font-extrabold text-blue-950 flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5 text-blue-600" /> Permanent QR & Access Behavior
                    </p>
                    <p>• <strong>One Permanent QR:</strong> The physical QR image never changes and never expires. Mount it in the classroom once.</p>
                    <p>• <strong>When DISABLED:</strong> Backend rejects all attendance requests immediately with: <em>&quot;Attendance is currently disabled by the administrator. Please wait until the administrator enables attendance.&quot;</em></p>
                    <p>• <strong>When ENABLED:</strong> Exact same permanent QR code accepts attendance immediately upon backend validation.</p>
                  </div>
                </div>

                {/* Printable Card Area */}
                <div className="lg:col-span-6 flex flex-col items-center">
                  <div
                    id="printable-asdc-qr-card"
                    className="w-full max-w-sm p-6 bg-white text-slate-900 rounded-2xl shadow-lg border-4 border-blue-600 flex flex-col items-center text-center"
                  >
                    <div className="mb-3">
                      <span className="text-[10px] font-black uppercase tracking-widest text-blue-700 block">
                        INSTITUTE ATTENDANCE
                      </span>
                      <h3 className="text-xl font-black text-slate-950 mt-0.5">
                        {INSTITUTE_CONFIG.INSTITUTE_NAME}
                      </h3>
                      <p className="text-xs font-bold text-slate-600">
                        {INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}
                      </p>
                    </div>

                    {qrDataUrl ? (
                      <div className="p-2.5 bg-white border-2 border-slate-200 rounded-xl shadow-inner">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={qrDataUrl}
                          alt="ASDC Permanent Classroom Attendance QR Code"
                          className="w-52 h-52 object-contain"
                        />
                      </div>
                    ) : (
                      <div className="w-52 h-52 flex items-center justify-center bg-slate-50 rounded-xl">
                        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}

                    <div className="mt-3 text-center">
                      <span
                        className={`inline-block px-3 py-1 text-[11px] font-black rounded-lg mb-1 shadow-sm ${
                          qrAccessStatus === 'ENABLED'
                            ? 'bg-emerald-100 border border-emerald-300 text-emerald-900'
                            : 'bg-rose-100 border border-rose-300 text-rose-900'
                        }`}
                      >
                        {qrAccessStatus === 'ENABLED'
                          ? 'Classroom QR: ENABLED'
                          : 'Classroom QR: DISABLED'}
                      </span>
                      <p className="text-[10px] text-slate-500 font-mono break-all leading-tight">
                        Permanent Original ASDC Classroom QR
                      </p>
                    </div>
                  </div>

                  {/* Print & Download Buttons */}
                  <div className="flex flex-wrap items-center justify-center gap-2.5 mt-4">
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-sm transition"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Print QR Code
                    </button>
                    {qrDataUrl && (
                      <a
                        href={qrDataUrl}
                        download="ASDC_Permanent_Classroom_QR.png"
                        className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 font-bold text-xs rounded-xl flex items-center gap-1.5 transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download PNG
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* 2. OFFICIAL ASDC GEOFENCE CONFIGURATION */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-emerald-600 text-white shadow-sm">
                    <Crosshair className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-950">Official ASDC Institute Geofence</h3>
                    <p className="text-xs text-slate-500 font-medium">
                      Attendance is strictly restricted to physical presence at the ASDC institute campus
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-6 space-y-6">
                {/* Official ASDC Campus Address & Verified Pin */}
                <div className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <span className="text-[10px] font-black uppercase tracking-wider text-emerald-800 block">
                      VERIFIED OFFICIAL INSTITUTE LOCATION
                    </span>
                    <h4 className="text-sm font-extrabold text-slate-950">
                      Advanced Skills Development Center (ASDC)
                    </h4>
                    <p className="text-xs text-slate-600 font-medium max-w-xl">
                      Shah Ali Banda Road, beside Masjid Aamwali, near Sultan-ul-Uloom School, Qazipura, Hyderabad, Telangana 500002, India
                    </p>
                    <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-xs text-emerald-900 font-bold">
                      <span className="px-2 py-0.5 bg-white rounded border border-emerald-300">
                        Lat: 17.34668005
                      </span>
                      <span className="px-2 py-0.5 bg-white rounded border border-emerald-300">
                        Lon: 78.46089325
                      </span>
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded">
                        Asia/Kolkata (IST)
                      </span>
                    </div>
                  </div>

                  <a
                    href="https://maps.app.goo.gl/MfGyprjpRgzpwjsV7"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 shadow-sm transition whitespace-nowrap"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open in Google Maps
                  </a>
                </div>

                {/* Geofence Parameters Form */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-5 rounded-2xl border border-slate-200">
                  {/* Radius Slider & Input */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-extrabold text-slate-900">
                        Permitted Geofence Radius
                      </label>
                      <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                        {geofenceRadiusInput} metres
                      </span>
                    </div>
                    <input
                      type="range"
                      min={20}
                      max={500}
                      step={5}
                      value={geofenceRadiusInput}
                      onChange={(e) => setGeofenceRadiusInput(Number(e.target.value))}
                      className="w-full accent-blue-600"
                    />
                    <p className="text-[11px] text-slate-500">
                      Students beyond this distance from ASDC center are immediately rejected and logged in security alerts.
                    </p>
                  </div>

                  {/* Accuracy Slider & Input */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-extrabold text-slate-900">
                        Max Allowed GPS Accuracy Uncertainty
                      </label>
                      <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                        ±{geofenceAccuracyInput} metres
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={150}
                      step={5}
                      value={geofenceAccuracyInput}
                      onChange={(e) => setGeofenceAccuracyInput(Number(e.target.value))}
                      className="w-full accent-blue-600"
                    />
                    <p className="text-[11px] text-slate-500">
                      Prevents spoofed or coarse IP fallbacks. Submissions with uncertainty &gt; {geofenceAccuracyInput}m are asked to retry.
                    </p>
                  </div>
                </div>

                {geofenceSuccessMessage && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 font-bold flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                    {geofenceSuccessMessage}
                  </div>
                )}
                {geofenceErrorMessage && (
                  <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900 font-bold flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-600" />
                    {geofenceErrorMessage}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleSaveGeofence}
                    disabled={isSavingGeofence}
                    className="px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl flex items-center gap-2 shadow-sm transition disabled:opacity-50"
                  >
                    {isSavingGeofence ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Save Geofence Settings
                  </button>
                </div>
              </div>
            </div>

            {/* 3. LOCATION SECURITY ALERTS & INCIDENT LOG */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-5 sm:p-6 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-rose-600 text-white shadow-sm">
                    <Shield className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-extrabold text-slate-950 flex items-center gap-2">
                      Location Security Alerts & Violations Log
                      {unreviewedIncidentsCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white font-black text-[11px] animate-pulse">
                          {unreviewedIncidentsCount} New
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-slate-500 font-medium">
                      Authoritative audit record of rejected scans, out-of-campus attempts, and expired QR submissions
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => loadLocationIncidents()}
                    disabled={isLoadingIncidents}
                    className="p-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 transition"
                    title="Refresh Incident Log"
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoadingIncidents ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Incidents Summary Metric Pills */}
              <div className="p-5 border-b border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-3 bg-slate-50/50">
                <div className="p-3 bg-white border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-500 block">Total Alerts</span>
                  <span className="text-lg font-black text-slate-900">{locationIncidents.length}</span>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-rose-600 block">Unreviewed</span>
                  <span className="text-lg font-black text-rose-600">{unreviewedIncidentsCount}</span>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-500 block">Outside Geofence</span>
                  <span className="text-lg font-black text-slate-900">
                    {locationIncidents.filter((i) => i.incidentType === 'OUTSIDE_GEOFENCE').length}
                  </span>
                </div>
                <div className="p-3 bg-white border border-slate-200 rounded-xl">
                  <span className="text-[11px] font-bold text-slate-500 block">Invalid QR Scans</span>
                  <span className="text-lg font-black text-slate-900">
                    {locationIncidents.filter((i) => i.incidentType === 'INVALID_QR_CHALLENGE').length}
                  </span>
                </div>
              </div>

              {/* Incident Filter Bar */}
              <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold overflow-x-auto">
                <span className="text-slate-500 font-bold mr-1">Filter:</span>
                <button
                  type="button"
                  onClick={() => setIncidentFilter('all')}
                  className={`px-3 py-1 rounded-lg transition ${
                    incidentFilter === 'all'
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  All ({locationIncidents.length})
                </button>
                <button
                  type="button"
                  onClick={() => setIncidentFilter('unreviewed')}
                  className={`px-3 py-1 rounded-lg transition ${
                    incidentFilter === 'unreviewed'
                      ? 'bg-rose-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Unreviewed ({unreviewedIncidentsCount})
                </button>
                <button
                  type="button"
                  onClick={() => setIncidentFilter('OUTSIDE_GEOFENCE')}
                  className={`px-3 py-1 rounded-lg transition ${
                    incidentFilter === 'OUTSIDE_GEOFENCE'
                      ? 'bg-amber-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Outside Campus
                </button>
                <button
                  type="button"
                  onClick={() => setIncidentFilter('INVALID_QR_CHALLENGE')}
                  className={`px-3 py-1 rounded-lg transition ${
                    incidentFilter === 'INVALID_QR_CHALLENGE'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  Invalid / Expired QR
                </button>
              </div>

              {/* Incident Table */}
              <div className="overflow-x-auto">
                {locationIncidents.length === 0 ? (
                  <div className="p-12 text-center text-xs text-slate-500 font-medium">
                    <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
                    No security violations recorded. Physical attendance is fully verified within campus.
                  </div>
                ) : (
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-extrabold uppercase text-[10px] tracking-wider">
                        <th className="py-3 px-4">Time (IST)</th>
                        <th className="py-3 px-4">Student</th>
                        <th className="py-3 px-4">Violation Type</th>
                        <th className="py-3 px-4">Reported Distance</th>
                        <th className="py-3 px-4">Accuracy</th>
                        <th className="py-3 px-4">Status</th>
                        <th className="py-3 px-4 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {locationIncidents
                        .filter((inc) => {
                          if (incidentFilter === 'unreviewed') return inc.status === 'New';
                          if (incidentFilter === 'OUTSIDE_GEOFENCE') return inc.incidentType === 'OUTSIDE_GEOFENCE';
                          if (incidentFilter === 'INVALID_QR_CHALLENGE') return inc.incidentType === 'INVALID_QR_CHALLENGE';
                          return true;
                        })
                        .map((incident) => (
                          <tr key={incident.id} className="hover:bg-slate-50/80 transition">
                            <td className="py-3 px-4 font-mono font-medium text-slate-600 whitespace-nowrap">
                              {formatDisplayTimestamp(incident.timestamp)}
                            </td>
                            <td className="py-3 px-4">
                              <span className="font-bold text-slate-900 block">{incident.studentName}</span>
                              <span className="font-mono text-[11px] text-slate-500">{incident.studentId}</span>
                            </td>
                            <td className="py-3 px-4">
                              <span
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-extrabold ${
                                  incident.incidentType === 'OUTSIDE_GEOFENCE'
                                    ? 'bg-rose-100 text-rose-800 border border-rose-200'
                                    : incident.incidentType === 'INVALID_QR_CHALLENGE'
                                    ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                    : incident.incidentType === 'INSUFFICIENT_LOCATION_ACCURACY'
                                    ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                    : 'bg-slate-100 text-slate-800 border border-slate-200'
                                }`}
                              >
                                {incident.incidentType}
                              </span>
                              {incident.details && (
                                <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-xs">{incident.details}</p>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono font-bold text-slate-800 whitespace-nowrap">
                              {incident.distanceMeters !== null && incident.distanceMeters !== undefined ? (
                                <span className={incident.distanceMeters > 100 ? 'text-rose-600' : 'text-slate-800'}>
                                  {Math.round(incident.distanceMeters)}m from ASDC
                                </span>
                              ) : (
                                <span className="text-slate-400">N/A</span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                              {incident.gpsAccuracy !== null && incident.gpsAccuracy !== undefined ? (
                                `±${Math.round(incident.gpsAccuracy)}m`
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                            <td className="py-3 px-4 whitespace-nowrap">
                              {incident.status === 'New' ? (
                                <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 font-extrabold text-[10px]">
                                  New
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 font-bold text-[10px]">
                                  Reviewed
                                </span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-right whitespace-nowrap">
                              {incident.status === 'New' ? (
                                <button
                                  type="button"
                                  onClick={() => handleReviewIncident(incident.id)}
                                  disabled={reviewingIncidentId === incident.id}
                                  className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-[11px] border border-slate-300 transition"
                                >
                                  {reviewingIncidentId === incident.id ? 'Reviewing...' : 'Mark Reviewed'}
                                </button>
                              ) : (
                                <span className="text-[10px] text-slate-400 font-medium">Reviewed</span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===================== TAB 3: HOLIDAYS & NON-CLASS DATES ===================== */}
        {activeTab === 'holidays' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Add Holiday Form */}
            <div className="md:col-span-1 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-950 mb-1 flex items-center gap-2">
                <Plus className="w-4 h-4 text-blue-600" />
                Declare Holiday / Non-Class Date
              </h3>
              <p className="text-xs text-slate-600 mb-4 font-medium">
                Students will not be marked Absent on declared holidays.
              </p>

              <form onSubmit={handleAddHoliday} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Date (YYYY-MM-DD) *
                  </label>
                  <input
                    type="date"
                    required
                    value={holidayDate}
                    onChange={(e) => setHolidayDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Holiday Title *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Diwali / Republic Day"
                    value={holidayTitle}
                    onChange={(e) => setHolidayTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Reason / Details (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. National holiday, institute closed"
                    value={holidayReason}
                    onChange={(e) => setHolidayReason(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={holidaySubmitting}
                  className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-50"
                >
                  {holidaySubmitting ? 'Saving...' : 'Add to Schedule'}
                </button>
              </form>
            </div>

            {/* Declared Holidays List */}
            <div className="md:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-950 mb-3 flex items-center justify-between">
                <span>Declared Holidays & Excluded Dates</span>
                <span className="text-xs font-semibold text-slate-500">
                  {Object.keys(holidays).length} dates listed
                </span>
              </h3>

              {Object.keys(holidays).length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-xl font-medium">
                  No holidays declared yet. All scheduled class days will require attendance.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {Object.values(holidays)
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((hol) => (
                      <div key={hol.date} className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-bold text-slate-900">
                              {hol.date}
                            </span>
                            <span className="text-xs font-bold text-purple-700">
                              {hol.title}
                            </span>
                          </div>
                          {hol.reason && (
                            <p className="text-[11px] text-slate-600 mt-0.5 font-medium">{hol.reason}</p>
                          )}
                          <span className="text-[10px] text-slate-500 font-mono">
                            Added by {hol.createdBy}
                          </span>
                        </div>
                        <button
                          onClick={() => handleRemoveHoliday(hol.date)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                          title="Delete Holiday"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===================== TAB 4: ANNOUNCEMENTS ===================== */}
        {activeTab === 'announcements' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Create Announcement Form */}
            <div className="md:col-span-1 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-950 mb-1 flex items-center gap-2">
                <Plus className="w-4 h-4 text-blue-600" />
                Publish Announcement
              </h3>
              <p className="text-xs text-slate-600 mb-4 font-medium">
                In-app notification visible immediately on student dashboards.
              </p>

              <form onSubmit={handleCreateAnnouncement} className="space-y-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Headline Title *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Workshop schedule / Holiday update"
                    value={annTitle}
                    onChange={(e) => setAnnTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Category Tag *
                  </label>
                  <select
                    value={annCategory}
                    onChange={(e) => setAnnCategory(e.target.value as any)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="GENERAL">General Notice</option>
                    <option value="HOLIDAY">Holiday Notice</option>
                    <option value="SCHEDULE">Class Schedule Change</option>
                    <option value="URGENT">Urgent Alert</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Message Body *
                  </label>
                  <textarea
                    required
                    rows={4}
                    placeholder="Details for students..."
                    value={annMessage}
                    onChange={(e) => setAnnMessage(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-medium text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <button
                  type="submit"
                  disabled={annSubmitting}
                  className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold shadow-sm transition disabled:opacity-50"
                >
                  {annSubmitting ? 'Publishing...' : 'Publish Announcement'}
                </button>
              </form>
            </div>

            {/* List Announcements */}
            <div className="md:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
              <h3 className="text-sm font-bold text-slate-950 mb-3 flex items-center justify-between">
                <span>Active Announcements</span>
                <span className="text-xs font-semibold text-slate-500">
                  {announcements.length} posted
                </span>
              </h3>

              {announcements.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 border border-dashed border-slate-300 rounded-xl font-medium">
                  No announcements published yet.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {announcements.map((ann) => (
                    <div key={ann.id} className="py-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-slate-950">{ann.title}</h4>
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                            {ann.category}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDeleteAnnouncement(ann.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition"
                          title="Delete announcement"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-medium">
                        {ann.message}
                      </p>
                      <div className="text-[10px] text-slate-500 font-mono">
                        Published by {ann.createdBy} • {formatDisplayTimestamp(ann.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===================== TAB 5: AUDIT LOGS ===================== */}
        {activeTab === 'audit' && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div>
                <h3 className="text-sm sm:text-base font-bold text-slate-950 flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-600" />
                  Administrative Audit Trail
                </h3>
                <p className="text-xs text-slate-600 mt-0.5 font-medium">
                  Every manual attendance override requires a documented reason and is permanently recorded.
                </p>
              </div>
              <span className="text-xs text-slate-600 font-mono font-bold">{auditLogs.length} entries</span>
            </div>

            <div className="overflow-x-auto">
              {auditLogs.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 font-medium">
                  No attendance corrections have been logged yet.
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 uppercase tracking-wider font-bold text-[11px]">
                      <th className="px-4 py-3">Timestamp (IST)</th>
                      <th className="px-4 py-3">Admin Email</th>
                      <th className="px-4 py-3">Student Affected</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Old Status → New Status</th>
                      <th className="px-4 py-3">Reason / Justification</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50 transition">
                        <td className="px-4 py-3 font-mono text-slate-600">
                          {formatDisplayTimestamp(log.timestamp)}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-800 font-semibold">
                          {log.adminEmail}
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-bold text-slate-950">{log.targetStudentName}</span>
                          <span className="text-slate-500 ml-1 font-mono">({log.targetStudentId})</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-800">
                          {log.targetDate}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-slate-400 line-through mr-1">{log.previousStatus || 'UNRECORDED'}</span>
                          <span className="font-bold text-emerald-700">→ {log.newStatus}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-800 font-medium">
                          {log.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ===================== TAB 6: SETTINGS & PILOT TESTING ===================== */}
        {activeTab === 'settings' && (
          <div className="space-y-6 max-w-4xl mx-auto">
            {/* Sole Admin Configuration Info Box */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <h3 className="text-base font-bold text-slate-950 mb-2 flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                Sole Authorized Admin Account
              </h3>
              <p className="text-xs text-slate-600 mb-4 leading-relaxed font-medium">
                Administrative access is strictly restricted to ONE exact Google account: <strong>{SOLE_ADMIN_EMAIL}</strong>. This restriction is enforced in frontend routing and Firestore Security Rules.
              </p>

              <div className="p-4 bg-blue-50/60 border border-blue-200 rounded-xl text-xs font-mono">
                <span className="text-[10px] text-blue-900 uppercase block font-sans font-bold">
                  Sole Authorized Administrator (mdausafmohiuddin@gmail.com)
                </span>
                <span className="text-blue-900 font-black text-sm block mt-1">
                  {SOLE_ADMIN_EMAIL}
                </span>
                <span className="text-[11px] text-slate-600 font-sans block mt-1 font-medium">
                  Configured in <code className="text-blue-800 font-bold">/lib/admin-config.ts</code> &amp; <code className="text-blue-800 font-bold">firestore.rules</code>
                </span>
              </div>
            </div>

            {/* Attendance Rules Summary */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <h3 className="text-base font-bold text-slate-950 mb-2 flex items-center gap-2">
                <Clock className="w-5 h-5 text-emerald-600" />
                Attendance Policy (Anytime 24/7)
              </h3>
              <div className="space-y-2 text-xs text-slate-700 font-medium">
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-500">Institute Name</span>
                  <span className="font-bold text-slate-950">{INSTITUTE_CONFIG.INSTITUTE_NAME}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-500">Course / Batch</span>
                  <span className="font-bold text-slate-950">{INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-500">Attendance Availability</span>
                  <span className="font-mono text-emerald-700 font-bold">Open Anytime (24/7 on class days)</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-slate-100">
                  <span className="text-slate-500">Timezone Enforced</span>
                  <span className="font-mono text-slate-900 font-semibold">{INSTITUTE_CONFIG.TIMEZONE} (Asia/Kolkata)</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-slate-500">Scheduled Class Days</span>
                  <span className="text-slate-900 font-semibold">Monday through Saturday (Sunday non-class)</span>
                </div>
              </div>
            </div>

            {/* 24/7 Test Verification Runner */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-base font-bold text-slate-950 flex items-center gap-2">
                  <CheckCheck className="w-5 h-5 text-emerald-600" />
                  24/7 Anytime Attendance Test Suite
                </h3>
                <button
                  onClick={runBoundaryTests}
                  disabled={testingBoundary}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition disabled:opacity-50 shadow-sm"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${testingBoundary ? 'animate-spin' : ''}`} />
                  Run Tests Now
                </button>
              </div>

              <p className="text-xs text-slate-600 mb-4 font-medium">
                Execute automated verification to confirm that QR attendance is accepted across all times of day (morning, afternoon, evening, and late night).
              </p>

              {testResult && (
                <div className="space-y-3">
                  <div
                    className={`p-3 rounded-xl border text-xs font-bold flex items-center justify-between ${
                      testResult.allPassed
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                        : 'bg-rose-50 border-rose-300 text-rose-900'
                    }`}
                  >
                    <span>{testResult.summary}</span>
                    <span>{testResult.totalTests} Scenarios Tested</span>
                  </div>

                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                    {testResult.results?.map((res: any, idx: number) => (
                      <div key={idx} className="p-3 bg-white flex items-center justify-between text-xs">
                        <div>
                          <p className="font-bold text-slate-950">{res.label}</p>
                          <p className="text-[11px] text-slate-500 font-mono">{res.message}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              res.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {res.passed ? 'PASS (OPEN)' : 'FAIL'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Student Detail Modal */}
      {selectedStudentForDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <span className="text-xs font-mono font-bold text-blue-700">
                  {selectedStudentForDetail.studentId}
                </span>
                <h3 className="text-lg font-bold text-slate-950">
                  {selectedStudentForDetail.fullName}
                </h3>
              </div>
              <button
                onClick={() => setSelectedStudentForDetail(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-700 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="my-4 space-y-2 text-xs font-medium">
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Google Account</span>
                <span className="font-mono text-slate-900">{selectedStudentForDetail.email}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Mobile Phone</span>
                <span className="font-mono text-slate-900">+91 {selectedStudentForDetail.phoneNumber}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Father&apos;s Name</span>
                <span className="text-slate-900">{selectedStudentForDetail.fatherName}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Mother&apos;s Name</span>
                <span className="text-slate-900">{selectedStudentForDetail.motherName}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Batch Code</span>
                <span className="text-slate-900">{selectedStudentForDetail.batchName}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-slate-500">Registered On</span>
                <span className="font-mono text-slate-700">
                  {formatDisplayTimestamp(selectedStudentForDetail.createdAt)}
                </span>
              </div>
            </div>

            <div className="mt-5 pt-4 border-t border-slate-200">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 mb-3">
                Attendance Log Records ({studentDetailRecords.length})
              </h4>
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 text-xs">
                {studentDetailRecords.length === 0 ? (
                  <p className="text-slate-500 py-3 text-center font-medium">No attendance records yet.</p>
                ) : (
                  studentDetailRecords.map((r) => (
                    <div key={r.id} className="py-2 flex items-center justify-between font-medium">
                      <span className="font-mono text-slate-900 font-semibold">{r.classDate}</span>
                      <span
                        className={`font-bold px-2 py-0.5 rounded text-[10px] ${
                          r.status === 'PRESENT'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-rose-100 text-rose-800'
                        }`}
                      >
                        {r.status}
                      </span>
                      <span className="text-slate-500 text-[11px] font-mono">
                        {r.source}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <button
              onClick={() => setSelectedStudentForDetail(null)}
              className="mt-6 w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Attendance Correction Modal with Mandatory Audit Reason */}
      {correctionModalStudent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative">
            <h3 className="text-base font-bold text-slate-950 mb-1">
              Correct Attendance Record
            </h3>
            <p className="text-xs text-slate-600 mb-4 font-medium">
              Student: <strong>{correctionModalStudent.fullName}</strong> ({correctionModalStudent.studentId}) on <span className="font-mono text-blue-700 font-bold">{selectedDate}</span>
            </p>

            <form onSubmit={handleSaveCorrection} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  New Attendance Status *
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['PRESENT', 'ABSENT', 'EXCUSED'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setCorrectionStatus(st)}
                      className={`py-2 rounded-lg font-bold transition text-xs ${
                        correctionStatus === st
                          ? st === 'PRESENT'
                            ? 'bg-emerald-600 text-white shadow-sm'
                            : st === 'ABSENT'
                            ? 'bg-rose-600 text-white shadow-sm'
                            : 'bg-blue-600 text-white shadow-sm'
                          : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Mandatory Audit Reason * (At least 5 characters)
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. Verified physical presence / Medical slip provided..."
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  Logged in permanent audit trail under {adminEmail}.
                </span>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCorrectionModalStudent(null)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold transition border border-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={correctionSubmitting || correctionReason.trim().length < 5}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold transition disabled:opacity-50 shadow-sm"
                >
                  {correctionSubmitting ? 'Logging...' : 'Apply & Audit Log'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Master Finalize Daily Attendance Modal */}
      {finalizingModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative">
            <div className="flex items-center gap-2.5 mb-2 text-amber-600">
              <CheckCheck className="w-6 h-6" />
              <h3 className="text-base font-extrabold text-slate-950">
                Finalize Daily Attendance
              </h3>
            </div>
            <p className="text-xs text-slate-600 mb-4 font-medium">
              You are about to officially close and finalize attendance for <strong className="font-mono text-slate-900 font-bold">{selectedDate}</strong> in the Master Excel Register.
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2 text-xs mb-5">
              <div className="flex justify-between">
                <span className="text-slate-500 font-medium">Total Registered Students:</span>
                <span className="font-bold text-slate-900">{masterInfo?.totalStudents || 24}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700 font-medium">Present (Will remain &apos;P&apos;):</span>
                <span className="font-bold text-emerald-700">{masterDailyData?.presentCount || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-rose-700 font-medium">Unmarked (Will be marked &apos;A&apos;):</span>
                <span className="font-bold text-rose-700">{masterDailyData?.unmarkedCount || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-medium">Already Confirmed Absent:</span>
                <span className="font-bold text-slate-700">{masterDailyData?.absentCount || 0}</span>
              </div>
            </div>

            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-xs mb-5 font-medium leading-relaxed">
              <strong>Confirmation Rule:</strong> All unrecorded students on {selectedDate} will receive &apos;A&apos; (Absent). Existing &apos;P&apos; records and all previous dates will remain intact. This action is permanently logged under <strong>{adminEmail}</strong>.
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFinalizingModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold transition border border-slate-200 text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmFinalize}
                disabled={finalizingSubmitting}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold transition disabled:opacity-50 shadow-sm text-xs flex items-center justify-center gap-1.5"
              >
                {finalizingSubmitting ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Finalizing...
                  </>
                ) : (
                  `Finalize Attendance for ${selectedDate}`
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Master Excel Cell Correction Modal */}
      {masterCorrectionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative">
            <h3 className="text-base font-bold text-slate-950 mb-1">
              Correct Master Attendance Entry
            </h3>
            <p className="text-xs text-slate-600 mb-4 font-medium">
              Student: <strong>{masterCorrectionModal.studentName}</strong> (Row {masterCorrectionModal.row}) • Date: <span className="font-mono text-emerald-800 font-bold">{masterCorrectionModal.date}</span> {masterCorrectionModal.cellRef ? `(Cell ${masterCorrectionModal.cellRef})` : ''}
            </p>

            <form onSubmit={handleConfirmMasterCorrection} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1.5">
                  Select New Status *
                </label>
                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setMasterCorrectionStatus('P')}
                    className={`py-2 rounded-lg font-bold transition text-xs ${
                      masterCorrectionStatus === 'P'
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    P (Present)
                  </button>
                  <button
                    type="button"
                    onClick={() => setMasterCorrectionStatus('A')}
                    className={`py-2 rounded-lg font-bold transition text-xs ${
                      masterCorrectionStatus === 'A'
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    A (Absent)
                  </button>
                  <button
                    type="button"
                    onClick={() => setMasterCorrectionStatus('L')}
                    className={`py-2 rounded-lg font-bold transition text-xs ${
                      masterCorrectionStatus === 'L'
                        ? 'bg-amber-600 text-white shadow-sm'
                        : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    L (Leave)
                  </button>
                  <button
                    type="button"
                    onClick={() => setMasterCorrectionStatus('')}
                    className={`py-2 rounded-lg font-bold transition text-xs ${
                      masterCorrectionStatus === ''
                        ? 'bg-slate-700 text-white shadow-sm'
                        : 'bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Clear (Empty)
                  </button>
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Mandatory Audit Reason * (At least 5 characters)
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="e.g. Verified presence on CCTV / Leave approved by teacher..."
                  value={masterCorrectionReason}
                  onChange={(e) => setMasterCorrectionReason(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-medium"
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  Logged in permanent audit trail under {adminEmail}.
                </span>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMasterCorrectionModal(null)}
                  className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold transition border border-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={masterCorrectionSubmitting || masterCorrectionReason.trim().length < 5}
                  className="flex-1 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-bold transition disabled:opacity-50 shadow-sm"
                >
                  {masterCorrectionSubmitting ? 'Updating...' : 'Save to Master Excel'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
