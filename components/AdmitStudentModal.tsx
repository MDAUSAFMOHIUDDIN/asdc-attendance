'use client';

import React, { useState } from 'react';
import { X, UserPlus, AlertCircle, CheckCircle2, Sparkles } from 'lucide-react';
import { INSTITUTE_CONFIG } from '@/lib/admin-config';
import { auth } from '@/lib/firebase';
import { StudentProfile } from '@/lib/types';

interface AdmitStudentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStudentAdmitted: (student: StudentProfile) => void;
}

export function AdmitStudentModal({ isOpen, onClose, onStudentAdmitted }: AdmitStudentModalProps) {
  const [fullName, setFullName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [fatherName, setFatherName] = useState('');
  const [motherName, setMotherName] = useState('');
  const [email, setEmail] = useState('');
  const [batchName, setBatchName] = useState(INSTITUTE_CONFIG.DEFAULT_BATCH_NAME);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<{ student: StudentProfile; inviteSent: boolean } | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!fullName.trim() || fullName.trim().length < 2) {
      setError('Student full name must be at least 2 characters.');
      return;
    }

    const cleanPhone = phoneNumber.trim().replace(/[^0-9]/g, '');
    if (cleanPhone.length !== 10) {
      setError('Please enter a valid 10-digit mobile phone number.');
      return;
    }

    if (!fatherName.trim() || fatherName.trim().length < 2) {
      setError("Father's name must be at least 2 characters.");
      return;
    }

    if (!motherName.trim() || motherName.trim().length < 2) {
      setError("Mother's name must be at least 2 characters.");
      return;
    }

    const cleanEmail = email.toLowerCase().trim();
    if (!cleanEmail || !cleanEmail.includes('@') || !cleanEmail.includes('.')) {
      setError('Please enter a valid student Gmail address.');
      return;
    }

    if (!confirmed) {
      setError('Please check the confirmation box to proceed with admission.');
      return;
    }

    setSubmitting(true);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken(true) : null;
      if (!idToken) {
        throw new Error('Administrator session expired. Please sign in again.');
      }

      const res = await fetch('/api/admin/students/admit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phoneNumber: cleanPhone,
          fatherName: fatherName.trim(),
          motherName: motherName.trim(),
          email: cleanEmail,
          batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
          batchName,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to admit new student.');
      }

      setSuccessResult({
        student: data.student,
        inviteSent: data.inviteSent,
      });

      onStudentAdmitted(data.student);
    } catch (err: any) {
      setError(err?.message || 'An error occurred during student admission.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetAndClose = () => {
    setFullName('');
    setPhoneNumber('');
    setFatherName('');
    setMotherName('');
    setEmail('');
    setConfirmed(false);
    setError(null);
    setSuccessResult(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-fadeIn my-8">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-xs">
              <UserPlus className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-950">Admit New Student</h2>
              <p className="text-xs text-slate-500">Official Institutional Registration & Excel Roster</p>
            </div>
          </div>
          <button
            onClick={handleResetAndClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        {successResult ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto shadow-xs">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-950">Student Admitted Successfully!</h3>
              <p className="text-xs text-slate-600 mt-1">
                The student account has been created, registered in Firestore, and added to the official Excel attendance roster.
              </p>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-left space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Assigned Student ID:</span>
                <span className="font-bold text-blue-700 text-sm">{successResult.student.studentId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Full Name:</span>
                <span className="font-bold text-slate-900">{successResult.student.fullName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Gmail Address:</span>
                <span className="text-slate-700">{successResult.student.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Mobile Phone:</span>
                <span className="text-slate-700">+91 {successResult.student.phoneNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Batch:</span>
                <span className="text-slate-700">{successResult.student.batchName}</span>
              </div>
            </div>

            {successResult.inviteSent ? (
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 text-left flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-600 flex-shrink-0" />
                <span>An account setup and password link was sent to the student's Gmail.</span>
              </div>
            ) : null}

            <button
              onClick={handleResetAndClose}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              Done & Return to Students List
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                <span className="font-medium leading-relaxed">{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Student Full Name <span className="text-rose-600">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Mohammed Farhan"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Mobile Phone (10 digits) <span className="text-rose-600">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-xs font-bold text-slate-500">+91</span>
                  <input
                    type="tel"
                    required
                    maxLength={10}
                    placeholder="9876543210"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value.replace(/[^0-9]/g, ''))}
                    className="w-full pl-11 pr-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Student Gmail Address <span className="text-rose-600">*</span>
                </label>
                <input
                  type="email"
                  required
                  placeholder="student@gmail.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Father's Name <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Father's full name"
                  value={fatherName}
                  onChange={(e) => setFatherName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Mother's Name <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Mother's full name"
                  value={motherName}
                  onChange={(e) => setMotherName(e.target.value)}
                  className="w-full px-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Course Batch Selection</label>
              <select
                value={batchName}
                onChange={(e) => setBatchName(e.target.value)}
                className="w-full px-3.5 py-2 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition font-medium"
              >
                <option value={INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}>
                  {INSTITUTE_CONFIG.DEFAULT_BATCH_NAME} (Evening 5pm - 9pm)
                </option>
                <option value="AI Builder Course">AI Builder Course (Batch-19)</option>
              </select>
            </div>

            {/* Confirmation Checkbox */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl">
              <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="font-medium leading-relaxed">
                  I confirm that this student is admitted to ASDC and should receive an atomic sequential Student ID and an invitation email.
                </span>
              </label>
            </div>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={handleResetAndClose}
                disabled={submitting}
                className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-100 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !confirmed}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-50 flex items-center gap-1.5"
              >
                {submitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Admitting Student...</span>
                  </>
                ) : (
                  <>
                    <UserPlus className="w-4 h-4" />
                    <span>Admit Student</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
