'use client';

import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { StudentDashboard } from '@/components/StudentDashboard';
import { AdminDashboard } from '@/components/AdminDashboard';
import { StudentRegistrationForm } from '@/components/StudentRegistrationForm';
import {
  GraduationCap,
  Shield,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Lock,
  LogOut,
} from 'lucide-react';
import { INSTITUTE_CONFIG, SOLE_ADMIN_EMAIL, ALLOWED_ADMIN_EMAILS } from '@/lib/admin-config';
import { checkAttendanceWindow, getISTTimeInfo } from '@/lib/date-utils';

function MainAppContent() {
  const {
    user,
    student,
    isAdmin,
    loading,
    isRegistered,
    loginWithGoogle,
    logout,
    refreshStudentProfile,
    markAnnouncementAsRead,
  } = useAuth();

  const [portalMode, setPortalMode] = useState<'landing' | 'student' | 'admin'>('landing');
  const [authError, setAuthError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [liveIstTime, setLiveIstTime] = useState<string>('');
  const [windowStatus, setWindowStatus] = useState(checkAttendanceWindow());

  // Real-time IST Clock
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const ist = getISTTimeInfo(now);
      setLiveIstTime(`${ist.timeString} IST`);
      setWindowStatus(checkAttendanceWindow(now));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  // Auto-route authenticated admin to admin dashboard
  useEffect(() => {
    if (user && isAdmin && portalMode === 'landing') {
      setPortalMode('admin');
    }
  }, [user, isAdmin, portalMode]);

  const handleLogout = async () => {
    try {
      await logout();
      setPortalMode('landing');
      setAuthError(null);
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  const handleStudentLogin = async () => {
    setAuthError(null);
    setLoggingIn(true);
    try {
      setPortalMode('student');
      await loginWithGoogle();
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setAuthError(err.message || 'Google sign-in was interrupted. Please try again.');
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const handleAdminLogin = async () => {
    setAuthError(null);
    setLoggingIn(true);
    try {
      setPortalMode('admin');
      await loginWithGoogle();
    } catch (err: any) {
      if (err.code !== 'auth/popup-closed-by-user') {
        setAuthError(err.message || 'Google sign-in was interrupted. Please try again.');
      }
    } finally {
      setLoggingIn(false);
    }
  };

  // Loading state
  if (loading && !loggingIn) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-4">
        <div className="w-12 h-12 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 mb-4 shadow-sm animate-pulse">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
        <p className="text-sm font-bold text-slate-900">Loading ASDC Attendance...</p>
        <p className="text-xs text-slate-500 mt-1">Connecting to institute database</p>
      </div>
    );
  }

  // If user is authenticated
  if (user) {
    // ADMIN PORTAL MODE
    if (portalMode === 'admin') {
      if (isAdmin) {
        return <AdminDashboard adminEmail={user.email || ''} onLogout={handleLogout} />;
      } else {
        // Logged in user is NOT the authorized sole admin
        return (
          <div className="min-h-screen bg-white flex items-center justify-center p-4">
            <div className="max-w-md w-full bg-white border border-rose-200 rounded-2xl p-6 sm:p-8 text-center shadow-xl">
              <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-200 text-rose-600 mx-auto mb-4 flex items-center justify-center shadow-sm">
                <Lock className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 mb-1">Access Denied</h2>
              <p className="text-sm font-semibold text-rose-600 mb-4 leading-relaxed">
                Access Denied: You are not authorized to access the ASDC Admin Dashboard.
              </p>

              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-xs font-mono mb-5 text-left space-y-2">
                <div>
                  <div className="text-slate-500 text-[10px] uppercase font-sans font-bold">
                    Signed In Google Account
                  </div>
                  <div className="text-slate-900 font-semibold truncate">{user.email}</div>
                </div>
                <div className="pt-1 border-t border-slate-200">
                  <div className="text-slate-500 text-[10px] uppercase font-sans font-bold">
                    Authorized Admins
                  </div>
                  <div className="text-blue-700 font-semibold space-y-0.5">
                    {ALLOWED_ADMIN_EMAILS.map((email) => (
                      <div key={email}>{email}</div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <button
                  onClick={() => setPortalMode('student')}
                  className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
                >
                  Continue to Student Portal
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold transition flex items-center justify-center gap-1.5 border border-slate-200"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out / Switch Account
                </button>
              </div>
            </div>
          </div>
        );
      }
    }

    // STUDENT PORTAL MODE
    if (!isRegistered) {
      return (
        <div className="min-h-screen bg-white flex flex-col justify-center py-10 px-4">
          <StudentRegistrationForm
            user={user}
            onRegistered={() => {
              refreshStudentProfile();
            }}
          />
        </div>
      );
    }

    if (student) {
      return (
        <StudentDashboard
          student={student}
          onLogout={handleLogout}
          onMarkAnnouncementRead={markAnnouncementAsRead}
        />
      );
    }
  }

  // ==================== LANDING SCREEN (BRIGHT WHITE DESIGN) ====================
  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col justify-between selection:bg-blue-600 selection:text-white">
      {/* Top Banner: Time & Status */}
      <div className="bg-slate-50 border-b border-slate-200 py-2.5 px-4 text-center">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-slate-800 font-medium">
              Classroom Attendance: <strong className="text-slate-950 font-bold">Open Anytime (24/7 on class days)</strong>
            </span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] text-slate-600">
            <span>Asia/Kolkata</span>
            <span className="text-slate-900 font-bold bg-white px-2 py-0.5 rounded border border-slate-200">{liveIstTime}</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-10 sm:py-16 flex-1 flex flex-col justify-center">
        {/* Brand & Heading */}
        <div className="text-center mb-10">
          <img
            src="/asdc-logo.png"
            alt="ASDC Logo"
            className="w-24 h-24 sm:w-28 sm:h-28 object-contain mx-auto mb-4 drop-shadow-sm"
          />
          <h1 className="text-3xl sm:text-4xl font-extrabold text-slate-950 tracking-tight">
            {INSTITUTE_CONFIG.INSTITUTE_FULL_NAME}
          </h1>
          <p className="text-sm sm:text-base text-slate-600 mt-2 max-w-lg mx-auto leading-relaxed">
            Institutional attendance and verified classroom recording system for ASDC. Fast, secure, and accessible 24/7.
          </p>

          <div className="mt-3.5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-semibold">
            <span>Course Batch:</span>
            <strong className="text-blue-950">{INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}</strong>
          </div>
        </div>

        {/* Error notification if login failed */}
        {authError && (
          <div className="mb-6 p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-rose-600 flex-shrink-0" />
            <p className="font-medium">{authError}</p>
          </div>
        )}

        {/* The Two Choice Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          {/* Option 1: Student Login */}
          <div className="bg-white border-2 border-slate-200 hover:border-blue-500 rounded-2xl p-6 sm:p-7 flex flex-col justify-between shadow-sm hover:shadow-md transition group">
            <div>
              <div className="w-12 h-12 rounded-xl bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center mb-4 group-hover:scale-105 transition shadow-sm">
                <GraduationCap className="w-6 h-6" />
              </div>
              <h2 className="text-xl font-bold text-slate-950 mb-2">Student Login</h2>
              <p className="text-xs text-slate-600 leading-relaxed mb-4">
                Access your institute profile, scan classroom QR codes anytime on class days, view attendance history, and read notices.
              </p>
              <ul className="text-xs text-slate-700 space-y-2 mb-6 font-medium">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
                  <span>Google Account Auto-Fill</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
                  <span>Unique ASDC-XXXX Student ID</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
                  <span>Classroom QR Attendance (Anytime)</span>
                </li>
              </ul>
            </div>

            <button
              onClick={handleStudentLogin}
              disabled={loggingIn}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold rounded-xl text-xs sm:text-sm shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition disabled:opacity-50"
            >
              <span>Continue with Google</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition" />
            </button>
          </div>

          {/* Option 2: Admin Login */}
          <div className="bg-white border-2 border-slate-200 hover:border-slate-400 rounded-2xl p-6 sm:p-7 flex flex-col justify-between shadow-sm hover:shadow-md transition group">
            <div>
              <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 text-slate-800 flex items-center justify-center mb-4 group-hover:scale-105 transition shadow-sm">
                <Shield className="w-6 h-6 text-emerald-600" />
              </div>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-xl font-bold text-slate-950">Admin Login</h2>
                <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                  Restricted
                </span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed mb-4">
                Exclusively for authorized ASDC administration. Manage students, print classroom QR codes, declare holidays, and export CSVs.
              </p>
              <ul className="text-xs text-slate-700 space-y-2 mb-6 font-medium">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Sole Admin Account Protection</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Printable Classroom QR Generator</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Excel / CSV Exports & Audit Logs</span>
                </li>
              </ul>
            </div>

            <button
              onClick={handleAdminLogin}
              disabled={loggingIn}
              className="w-full py-3 px-4 bg-slate-900 hover:bg-slate-800 active:bg-black text-white font-bold rounded-xl text-xs sm:text-sm shadow-md flex items-center justify-center gap-2 transition disabled:opacity-50"
            >
              <span>Admin Google Sign-In</span>
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition" />
            </button>
          </div>
        </div>

        {/* Security Disclaimers & Operational Details */}
        <div className="mt-10 p-4 bg-slate-50 border border-slate-200 rounded-xl flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-600 text-center sm:text-left">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-blue-600 flex-shrink-0" />
            <span>
              Zero-Trust Architecture: Students cannot access or list administrative data.
            </span>
          </div>
          <span className="font-mono text-[11px] text-slate-500 font-semibold">
            ASDC Attendance • Production Ready
          </span>
        </div>
      </div>

      {/* Footer */}
      <footer className="py-6 border-t border-slate-200 bg-white text-center text-xs text-slate-600">
        <p>© {new Date().getFullYear()} {INSTITUTE_CONFIG.INSTITUTE_FULL_NAME}. All rights reserved.</p>
        <p className="mt-1.5 text-xs text-slate-600 font-medium">
          Developed by <strong className="font-bold text-slate-900">MD AUSAF MOHIUDDIN</strong> | Contact:{' '}
          <a href="tel:9618890557" className="text-blue-600 hover:text-blue-800 font-bold hover:underline font-mono">9618890557</a>
        </p>
      </footer>
    </div>
  );
}

export default function HomePage() {
  return (
    <AuthProvider>
      <MainAppContent />
    </AuthProvider>
  );
}
