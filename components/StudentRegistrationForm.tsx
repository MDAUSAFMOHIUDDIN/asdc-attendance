'use client';

import React, { useState } from 'react';
import { User } from 'firebase/auth';
import { UserCheck, BookOpen, HeartHandshake, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { registerStudentWithSequentialId } from '@/lib/student-service';
import { StudentProfile } from '@/lib/types';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';

interface StudentRegistrationFormProps {
  user: User;
  onRegistered: (profile: StudentProfile) => void;
}

export function StudentRegistrationForm({ user, onRegistered }: StudentRegistrationFormProps) {
  const [fullName, setFullName] = useState(user.displayName || '');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [motherName, setMotherName] = useState('');
  const [batchId] = useState(INSTITUTE_CONFIG.DEFAULT_BATCH_ID);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    // Validation
    if (!fullName.trim() || fullName.trim().length < 2) {
      setErrorMsg('Please enter your full legal name (minimum 2 characters).');
      return;
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length !== 10) {
      setErrorMsg('Please enter a valid 10-digit mobile phone number.');
      return;
    }

    if (!fatherName.trim() || fatherName.trim().length < 2) {
      setErrorMsg("Please enter your father's full name.");
      return;
    }

    if (!motherName.trim() || motherName.trim().length < 2) {
      setErrorMsg("Please enter your mother's full name.");
      return;
    }

    setLoading(true);

    try {
      const studentProfile = await registerStudentWithSequentialId({
        uid: user.uid,
        fullName: fullName.trim(),
        phoneNumber: cleanPhone,
        fatherName: fatherName.trim(),
        motherName: motherName.trim(),
        email: user.email || '',
        batchId,
        batchName: INSTITUTE_CONFIG.DEFAULT_BATCH_NAME,
      });

      onRegistered(studentProfile);
    } catch (err) {
      console.error('Registration failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-lg mx-auto bg-white border border-slate-200 rounded-2xl shadow-xl p-6 sm:p-8">
      {/* Brand Header */}
      <div className="text-center mb-6">
        <img
          src="/asdc-logo.png"
          alt="ASDC Logo"
          className="w-20 h-20 object-contain mx-auto mb-3 drop-shadow-sm"
        />
        <h2 className="text-xl sm:text-2xl font-bold text-slate-950 tracking-tight">
          Complete Student Registration
        </h2>
        <p className="text-xs sm:text-sm text-slate-600 mt-1">
          Welcome to <span className="text-blue-700 font-bold">{INSTITUTE_CONFIG.INSTITUTE_NAME}</span>. Register your profile to receive your institutional Student ID.
        </p>
      </div>

      {errorMsg && (
        <div className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-3 text-xs sm:text-sm text-rose-800">
          <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
          <p className="font-medium">{errorMsg}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Full Name */}
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
            Full Name *
          </label>
          <input
            type="text"
            required
            placeholder="e.g. Rahul Sharma"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={loading}
            className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
          />
        </div>

        {/* Gmail Address (Prefilled and Disabled) */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
              Verified Google Account (Gmail)
            </label>
            <span className="text-[11px] text-blue-700 flex items-center gap-1 font-semibold">
              <ShieldCheck className="w-3.5 h-3.5" /> Locked
            </span>
          </div>
          <input
            type="email"
            value={user.email || ''}
            disabled
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-600 font-mono text-sm cursor-not-allowed select-none"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Institutional records are permanently tied to this authenticated Google address.
          </p>
        </div>

        {/* Phone Number */}
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
            Mobile Number (10 Digits) *
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-2.5 text-slate-500 text-sm font-semibold">+91</span>
            <input
              type="tel"
              required
              maxLength={10}
              placeholder="9876543210"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
              disabled={loading}
              className="w-full pl-12 pr-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
            />
          </div>
        </div>

        {/* Parents' Details Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Father&apos;s Name *
            </label>
            <input
              type="text"
              required
              placeholder="Father's full name"
              value={fatherName}
              onChange={(e) => setFatherName(e.target.value)}
              disabled={loading}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Mother&apos;s Name *
            </label>
            <input
              type="text"
              required
              placeholder="Mother's full name"
              value={motherName}
              onChange={(e) => setMotherName(e.target.value)}
              disabled={loading}
              className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition shadow-sm"
            />
          </div>
        </div>

        {/* Course / Batch Selection */}
        <div>
          <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
            Course Batch *
          </label>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <BookOpen className="w-4 h-4 text-blue-600" />
              <div>
                <p className="text-sm font-bold text-slate-900">{INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}</p>
                <p className="text-xs text-slate-500">Attendance: Open anytime on class days</p>
              </div>
            </div>
            <span className="text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-200 px-2 py-0.5 rounded">
              Active Cohort
            </span>
          </div>
        </div>

        {/* Submit Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full mt-6 py-3 px-4 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-bold rounded-xl text-sm shadow-md shadow-blue-500/20 flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Generating Institutional ID & Registering...</span>
            </>
          ) : (
            <>
              <HeartHandshake className="w-4 h-4" />
              <span>Complete Registration</span>
            </>
          )}
        </button>
      </form>
    </div>
  );
}
