'use client';

import React, { useState } from 'react';
import { X, Trash2, AlertTriangle, AlertCircle, CheckCircle2 } from 'lucide-react';
import { StudentProfile } from '@/lib/types';
import { auth } from '@/lib/firebase';

interface DeleteStudentModalProps {
  student: StudentProfile | null;
  isOpen: boolean;
  onClose: () => void;
  onStudentDeleted: (studentUid: string, studentId: string) => void;
}

export function DeleteStudentModal({
  student,
  isOpen,
  onClose,
  onStudentDeleted,
}: DeleteStudentModalProps) {
  const [typedId, setTypedId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteCompleted, setDeleteCompleted] = useState(false);

  if (!isOpen || !student) return null;

  const isMatch = typedId.trim().toUpperCase() === student.studentId.trim().toUpperCase();

  const handleDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isMatch) {
      setError(`Confirmation failed: You must type '${student.studentId}' to confirm permanent deletion.`);
      return;
    }

    setDeleting(true);
    setError(null);

    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken(true) : null;
      if (!idToken) {
        throw new Error('Administrator session expired. Please sign in again.');
      }

      const res = await fetch('/api/admin/students/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          studentUid: student.uid,
          studentId: student.studentId,
          confirmStudentId: typedId.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to permanently delete student.');
      }

      setDeleteCompleted(true);
      onStudentDeleted(student.uid, student.studentId);
    } catch (err: any) {
      setError(err?.message || 'Failed to delete student.');
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    setTypedId('');
    setError(null);
    setDeleteCompleted(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-rose-200 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-fadeIn my-8">
        {/* Header */}
        <div className="p-5 border-b border-rose-100 bg-rose-50/70 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-rose-600 text-white flex items-center justify-center shadow-xs">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-950">Remove Student Permanently</h2>
              <p className="text-xs text-rose-700 font-medium">Irreversible Account & Data Deletion</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        {deleteCompleted ? (
          <div className="p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto shadow-xs">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-950">Student Permanently Removed</h3>
              <p className="text-xs text-slate-600 mt-1">
                All records, authentication credentials, and official Master Excel entries for <strong>{student.fullName}</strong> ({student.studentId}) have been completely erased.
              </p>
            </div>
            <button
              onClick={handleClose}
              className="w-full py-2.5 bg-slate-900 hover:bg-black text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              Close & Return to Dashboard
            </button>
          </div>
        ) : (
          <form onSubmit={handleDelete} className="p-6 space-y-4">
            {/* Warning Alert */}
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900 space-y-2">
              <div className="flex items-center gap-2 font-bold text-rose-800 text-sm">
                <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                <span>Permanent Deletion Warning</span>
              </div>
              <p className="leading-relaxed">
                This operation is <strong>permanent and irreversible</strong>. The student will be permanently deleted from:
              </p>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-rose-800 font-medium pl-1">
                <li>Firebase Authentication (Account login revoked immediately)</li>
                <li>Firestore Student Profile</li>
                <li>All Historical Attendance Records</li>
                <li>Push Notification Subscriptions & Targeted Alerts</li>
                <li>The Official Master Excel Workbook (Personal info & attendance cells cleared)</li>
              </ul>
            </div>

            {/* Target Student Details */}
            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Target Student:</span>
                <span className="font-bold text-slate-900 font-sans">{student.fullName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Student ID:</span>
                <span className="font-bold text-rose-700">{student.studentId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 font-sans">Gmail:</span>
                <span className="text-slate-700">{student.email}</span>
              </div>
            </div>

            {error && (
              <div className="p-3 bg-rose-100 border border-rose-300 rounded-xl text-xs text-rose-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                <span className="font-medium leading-relaxed">{error}</span>
              </div>
            )}

            {/* Confirmation Input Requirement */}
            <div>
              <label className="block text-xs font-bold text-slate-800 mb-1.5 leading-relaxed">
                To confirm permanent deletion, type the exact Student ID{' '}
                <strong className="text-rose-700 font-mono underline">{student.studentId}</strong> below:
              </label>
              <input
                type="text"
                required
                placeholder={`Type ${student.studentId}`}
                value={typedId}
                onChange={(e) => setTypedId(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-rose-500 transition font-mono font-bold"
              />
            </div>

            {/* Action buttons */}
            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={handleClose}
                disabled={deleting}
                className="px-4 py-2 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-100 transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deleting || !isMatch}
                className="px-5 py-2 bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {deleting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Permanently Removing...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    <span>Permanently Remove Student</span>
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
