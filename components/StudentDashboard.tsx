'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  QrCode,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  Bell,
  LogOut,
  GraduationCap,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { StudentProfile, AttendanceRecord, Announcement, Holiday, StudentAttendanceSummary } from '@/lib/types';
import { getStudentAttendanceRecords, getAnnouncements, getHolidays, calculateStudentSummary } from '@/lib/attendance-service';
import { formatDisplayDate, formatDisplayTimestamp, checkAttendanceWindow, getISTTimeInfo } from '@/lib/date-utils';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { db } from '@/lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { QRScannerModal } from './QRScannerModal';

interface StudentDashboardProps {
  student: StudentProfile;
  onLogout: () => void;
  onMarkAnnouncementRead: (id: string) => void;
}

export function StudentDashboard({
  student,
  onLogout,
  onMarkAnnouncementRead,
}: StudentDashboardProps) {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [holidays, setHolidays] = useState<Record<string, Holiday>>({});
  const [loading, setLoading] = useState(true);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [liveIstTime, setLiveIstTime] = useState<string>('');
  const [windowStatus, setWindowStatus] = useState(checkAttendanceWindow());
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [qrAccessStatus, setQrAccessStatus] = useState<'ENABLED' | 'DISABLED'>('ENABLED');

  // Real-time listener for Administrator QR Access ON/OFF state
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      const docRef = doc(db, 'settings', 'qr_access');
      unsubscribe = onSnapshot(
        docRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const isEnabled =
              typeof data?.qrAccessEnabled === 'boolean'
                ? data.qrAccessEnabled
                : data?.status === 'ENABLED';
            setQrAccessStatus(isEnabled ? 'ENABLED' : 'DISABLED');
          }
        },
        (err) => console.warn('Student QR access listener notice:', err)
      );
    } catch (err) {
      // fallback
    }
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const handleCloseScanner = useCallback(() => {
    setScannerOpen(false);
  }, []);

  const handleAttendanceSuccess = useCallback((newRecord: AttendanceRecord) => {
    setRecords((prev) => {
      const filtered = prev.filter((r) => r.id !== newRecord.id);
      return [newRecord, ...filtered];
    });
  }, []);

  // Update IST clock every second
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

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [recList, annList, holList] = await Promise.all([
        getStudentAttendanceRecords(student.uid),
        getAnnouncements(),
        getHolidays(),
      ]);
      setRecords(recList);
      setAnnouncements(annList);
      setHolidays(holList);
    } catch (err) {
      console.error('Failed to load student data:', err);
    } finally {
      setLoading(false);
    }
  }, [student.uid]);

  // Initial load with cleanup to prevent cascading renders
  useEffect(() => {
    let isMounted = true;
    Promise.all([
      getStudentAttendanceRecords(student.uid),
      getAnnouncements(),
      getHolidays(),
    ]).then(([recList, annList, holList]) => {
      if (isMounted) {
        setRecords(recList);
        setAnnouncements(annList);
        setHolidays(holList);
        setLoading(false);
      }
    }).catch(console.error);

    return () => {
      isMounted = false;
    };
  }, [student.uid]);

  // Today's attendance status calculation
  const todayIST = getISTTimeInfo();
  const todayDateStr = todayIST.dateString;
  const isTodayHoliday = Boolean(holidays[todayDateStr]);
  const todayRecord = records.find((r) => r.classDate === todayDateStr);

  let todayStatusDisplay = {
    label: 'Not Yet Recorded',
    sub: 'Attendance is open today. Tap Scan Classroom QR to record attendance.',
    color: 'text-amber-800 bg-amber-50 border-amber-300',
    icon: Clock,
  };

  if (isTodayHoliday) {
    todayStatusDisplay = {
      label: 'Holiday Today',
      sub: holidays[todayDateStr]?.title || 'Institute Holiday',
      color: 'text-purple-800 bg-purple-50 border-purple-300',
      icon: Sparkles,
    };
  } else if (todayRecord) {
    if (todayRecord.status === 'PRESENT') {
      todayStatusDisplay = {
        label: 'PRESENT',
        sub: `Verified via ${todayRecord.source === 'QR_SCAN' ? 'Classroom QR' : 'Institute Override'} at ${formatDisplayTimestamp(todayRecord.verifiedAt)}`,
        color: 'text-emerald-800 bg-emerald-50 border-emerald-300',
        icon: CheckCircle,
      };
    } else if (todayRecord.status === 'ABSENT') {
      todayStatusDisplay = {
        label: 'ABSENT',
        sub: todayRecord.correctionReason ? `Note: ${todayRecord.correctionReason}` : 'Marked absent for this class date.',
        color: 'text-rose-800 bg-rose-50 border-rose-300',
        icon: XCircle,
      };
    } else if (todayRecord.status === 'EXCUSED') {
      todayStatusDisplay = {
        label: 'EXCUSED',
        sub: todayRecord.correctionReason || 'Official Institute Leave',
        color: 'text-blue-800 bg-blue-50 border-blue-300',
        icon: Sparkles,
      };
    }
  }

  // Summary Metrics
  const summary: StudentAttendanceSummary = calculateStudentSummary(
    student,
    records,
    holidays
  );

  const unreadAnnouncementsCount = announcements.filter(
    (a) => !student.readAnnouncementIds?.includes(a.id)
  ).length;

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col pb-12 selection:bg-blue-600 selection:text-white">
      {/* Top Navigation */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center font-black tracking-wider text-white shadow-sm shadow-blue-500/20">
              AS
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-950 text-base tracking-tight">
                  {INSTITUTE_CONFIG.INSTITUTE_FULL_NAME}
                </span>
                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                  Student
                </span>
              </div>
              <p className="text-xs text-slate-500">Portal & Live Attendance</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Live IST Clock Badge */}
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-700">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-semibold">{liveIstTime || 'Connecting...'}</span>
            </div>

            <button
              onClick={() => setProfileModalOpen(true)}
              className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold text-slate-800 border border-slate-200 transition"
            >
              My ID Card
            </button>

            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition"
              title="Sign Out"
              aria-label="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-4xl mx-auto w-full px-4 sm:px-6 pt-6 space-y-6">
        {/* Welcome & Student ID Banner */}
        <div className="relative overflow-hidden bg-slate-50 border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-700">
                  {student.batchName}
                </span>
                <span className="text-slate-400">•</span>
                <span className="text-xs text-slate-600 font-mono font-bold">ID: {student.studentId}</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950 tracking-tight">
                Welcome back, {student.fullName}
              </h1>
              <p className="text-xs sm:text-sm text-slate-600 mt-1">
                Attendance availability: <strong className="text-slate-900 font-bold">Open anytime (24/7 on class days)</strong>
              </p>
            </div>

            {/* Quick Action: Scan QR Button */}
            <div className="flex-shrink-0">
              <button
                disabled={qrAccessStatus !== 'ENABLED'}
                onClick={() => {
                  if (qrAccessStatus === 'ENABLED') {
                    setScannerOpen(true);
                  }
                }}
                className={`w-full sm:w-auto px-5 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2.5 shadow-md transition ${
                  qrAccessStatus !== 'ENABLED'
                    ? 'bg-slate-200 text-slate-500 cursor-not-allowed border border-slate-300 shadow-none'
                    : todayRecord && todayRecord.status === 'PRESENT'
                    ? 'bg-emerald-50 text-emerald-800 border-2 border-emerald-300 hover:bg-emerald-100'
                    : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-blue-500/20'
                }`}
              >
                <QrCode className="w-5 h-5" />
                <span>
                  {qrAccessStatus !== 'ENABLED'
                    ? 'QR Access Disabled'
                    : todayRecord && todayRecord.status === 'PRESENT'
                    ? 'Scan Again / Verified'
                    : 'Scan Classroom QR'}
                </span>
              </button>
            </div>
          </div>

          {/* Status helper banner */}
          <div className="mt-4 pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  qrAccessStatus === 'ENABLED' ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
                }`}
              />
              <span className={`font-medium ${qrAccessStatus === 'ENABLED' ? 'text-slate-700' : 'text-rose-700 font-bold'}`}>
                {qrAccessStatus === 'ENABLED'
                  ? 'Classroom attendance scanner is active.'
                  : 'ADMIN HAS DISABLED ATTENDANCE ACCESS. You cannot scan the classroom QR or mark attendance right now. Please wait until the administrator enables access.'}
              </span>
            </div>
            <span className="text-slate-600 font-mono text-[11px] sm:hidden font-semibold">
              {liveIstTime}
            </span>
          </div>
        </div>

        {/* Today's Status & Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Today's Attendance Card */}
          <div className="sm:col-span-1 bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between shadow-sm">
            <div>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Today&apos;s Status
                </span>
                <span className="text-xs text-slate-600 font-mono font-semibold">{todayDateStr}</span>
              </div>
              <div
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-bold ${todayStatusDisplay.color}`}
              >
                <todayStatusDisplay.icon className="w-4 h-4" />
                <span>{todayStatusDisplay.label}</span>
              </div>
            </div>
            <p className="text-xs text-slate-600 mt-4 leading-relaxed font-medium">
              {todayStatusDisplay.sub}
            </p>
          </div>

          {/* Attendance Percentage Card */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Attendance Rate
              </span>
              <span className="text-xs text-blue-700 font-bold">Goal: 75%</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-extrabold text-slate-950">
                {summary.attendancePercentage}%
              </span>
              <span className="text-xs text-slate-600 font-medium">
                ({summary.presentCount} of {summary.totalClassesScheduled} classes)
              </span>
            </div>
            {/* Progress bar */}
            <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden mt-3 border border-slate-200">
              <div
                className={`h-full transition-all duration-500 rounded-full ${
                  summary.attendancePercentage >= 75 ? 'bg-emerald-600' : 'bg-amber-500'
                }`}
                style={{ width: `${Math.min(100, Math.max(0, summary.attendancePercentage))}%` }}
              />
            </div>
          </div>

          {/* Quick Stats Breakdown */}
          <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Record Breakdown
              </span>
              <GraduationCap className="w-4 h-4 text-slate-400" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-center pt-1">
              <div className="bg-emerald-50 p-2 rounded-xl border border-emerald-200">
                <span className="block text-lg font-extrabold text-emerald-800">{summary.presentCount}</span>
                <span className="text-[10px] uppercase font-bold text-emerald-700">Present</span>
              </div>
              <div className="bg-rose-50 p-2 rounded-xl border border-rose-200">
                <span className="block text-lg font-extrabold text-rose-800">{summary.absentCount}</span>
                <span className="text-[10px] uppercase font-bold text-rose-700">Absent</span>
              </div>
              <div className="bg-blue-50 p-2 rounded-xl border border-blue-200">
                <span className="block text-lg font-extrabold text-blue-800">{summary.excusedCount}</span>
                <span className="text-[10px] uppercase font-bold text-blue-700">Excused</span>
              </div>
            </div>
          </div>
        </div>

        {/* Announcements Section */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm sm:text-base font-bold text-slate-950">Institute Announcements</h2>
              {unreadAnnouncementsCount > 0 && (
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-600 text-white">
                  {unreadAnnouncementsCount} New
                </span>
              )}
            </div>
            <button
              onClick={loadData}
              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-200 transition"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
            {announcements.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500 font-medium">
                No active announcements right now.
              </div>
            ) : (
              announcements.map((ann) => {
                const isRead = student.readAnnouncementIds?.includes(ann.id);
                return (
                  <div
                    key={ann.id}
                    className={`p-4 sm:p-5 transition flex flex-col gap-1.5 ${
                      isRead ? 'bg-white opacity-75' : 'bg-blue-50/30'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {!isRead && (
                          <span className="w-2 h-2 rounded-full bg-blue-600 flex-shrink-0" />
                        )}
                        <h3 className="text-sm font-bold text-slate-950">{ann.title}</h3>
                        <span
                          className={`text-[10px] uppercase px-1.5 py-0.5 rounded font-bold ${
                            ann.category === 'URGENT'
                              ? 'bg-rose-100 text-rose-800 border border-rose-200'
                              : ann.category === 'HOLIDAY'
                              ? 'bg-purple-100 text-purple-800 border border-purple-200'
                              : ann.category === 'SCHEDULE'
                              ? 'bg-amber-100 text-amber-800 border border-amber-200'
                              : 'bg-blue-100 text-blue-800 border border-blue-200'
                          }`}
                        >
                          {ann.category}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-500 font-mono">
                        {formatDisplayTimestamp(ann.createdAt).split('at')[0]}
                      </span>
                    </div>
                    <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-medium">
                      {ann.message}
                    </p>
                    {!isRead && (
                      <div className="pt-1">
                        <button
                          onClick={() => onMarkAnnouncementRead(ann.id)}
                          className="text-[11px] text-blue-700 hover:text-blue-900 underline font-bold"
                        >
                          Mark as read
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Attendance History Section */}
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-blue-600" />
              <h2 className="text-sm sm:text-base font-bold text-slate-950">Attendance History</h2>
            </div>
            <span className="text-xs font-semibold text-slate-500">Total Records: {records.length}</span>
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-600 flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                <span>Loading attendance logs...</span>
              </div>
            ) : records.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500 font-medium">
                No attendance records recorded yet. Scan classroom QR to mark attendance.
              </div>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-700 uppercase tracking-wider font-bold text-[11px]">
                    <th className="px-4 py-3">Class Date</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Submission Type</th>
                    <th className="px-4 py-3">Timestamp (IST)</th>
                    <th className="px-4 py-3">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {records.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50 transition">
                      <td className="px-4 py-3 font-semibold text-slate-950">
                        {formatDisplayDate(r.classDate)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md font-bold text-[11px] ${
                            r.status === 'PRESENT'
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              : r.status === 'EXCUSED'
                              ? 'bg-blue-100 text-blue-800 border border-blue-200'
                              : 'bg-rose-100 text-rose-800 border border-rose-200'
                          }`}
                        >
                          {r.status === 'PRESENT' ? (
                            <CheckCircle className="w-3 h-3 text-emerald-700" />
                          ) : (
                            <XCircle className="w-3 h-3 text-rose-700" />
                          )}
                          {r.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-medium">
                        {r.source === 'QR_SCAN' ? 'Classroom QR Code' : 'Admin Manual Update'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 font-mono font-medium">
                        {formatDisplayTimestamp(r.verifiedAt)}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.correctionReason || 'Verified'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>

      {/* QR Scanner Modal */}
      {scannerOpen && (
        <QRScannerModal
          student={student}
          isOpen={scannerOpen}
          onClose={handleCloseScanner}
          onAttendanceSuccess={handleAttendanceSuccess}
        />
      )}

      {/* Student Profile / ID Card Modal (Bright White Design) */}
      {profileModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative">
            <div className="text-center pb-4 border-b border-slate-200">
              <span className="text-[10px] font-extrabold uppercase tracking-widest text-blue-700">
                Official Institutional Credential
              </span>
              <h3 className="text-lg font-black text-slate-950 mt-1">
                {INSTITUTE_CONFIG.INSTITUTE_NAME} ID CARD
              </h3>
              <p className="text-xs font-semibold text-slate-500">{student.batchName}</p>
            </div>

            <div className="my-5 text-center bg-blue-50/60 p-4 rounded-xl border border-blue-200">
              <span className="text-xs text-blue-900 font-bold uppercase tracking-wider">Student Institutional ID</span>
              <p className="text-2xl font-mono font-black text-blue-700 tracking-wider mt-1">
                {student.studentId}
              </p>
            </div>

            <div className="space-y-2.5 text-xs font-medium">
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Student Name</span>
                <span className="font-bold text-slate-950">{student.fullName}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Google Account</span>
                <span className="font-mono text-slate-800">{student.email}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Mobile Phone</span>
                <span className="font-mono text-slate-800">+91 {student.phoneNumber}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Father&apos;s Name</span>
                <span className="text-slate-900">{student.fatherName}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-slate-500">Mother&apos;s Name</span>
                <span className="text-slate-900">{student.motherName}</span>
              </div>
            </div>

            <button
              onClick={() => setProfileModalOpen(false)}
              className="mt-6 w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
