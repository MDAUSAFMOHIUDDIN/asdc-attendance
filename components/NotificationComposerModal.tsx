'use client';

import React, { useState } from 'react';
import { Send, X, AlertCircle, CheckCircle2, Users, User, Bell } from 'lucide-react';
import { StudentProfile } from '@/lib/types';

interface NotificationComposerModalProps {
  adminEmail: string;
  students: StudentProfile[];
  onClose: () => void;
  onSuccess?: () => void;
}

export function NotificationComposerModal({
  adminEmail,
  students,
  onClose,
  onSuccess,
}: NotificationComposerModalProps) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [category, setCategory] = useState<'GENERAL' | 'URGENT' | 'ATTENDANCE' | 'REMINDER'>('GENERAL');
  const [targetType, setTargetType] = useState<'ALL' | 'SPECIFIC'>('ALL');
  const [selectedStudentUid, setSelectedStudentUid] = useState<string>(students[0]?.uid || '');
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMessage(null);

    if (!title.trim() || title.trim().length < 3) {
      setStatusMessage({ type: 'error', text: 'Title must be at least 3 characters long.' });
      return;
    }
    if (!message.trim() || message.trim().length < 5) {
      setStatusMessage({ type: 'error', text: 'Message must be at least 5 characters long.' });
      return;
    }

    const recipientUid = targetType === 'ALL' ? 'ALL' : selectedStudentUid;
    const selectedStudent = students.find((s) => s.uid === selectedStudentUid);
    const recipientName = targetType === 'ALL' ? 'All Registered Students' : selectedStudent?.fullName || 'Student';

    setSubmitting(true);
    try {
      const response = await fetch('/api/notifications/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminEmail,
          title: title.trim(),
          message: message.trim(),
          category,
          recipientUid,
          recipientName,
          url: '/',
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send notification');
      }

      setStatusMessage({
        type: 'success',
        text: data.message || 'Notification broadcasted successfully.',
      });

      setTimeout(() => {
        if (onSuccess) onSuccess();
        onClose();
      }, 1500);
    } catch (err: any) {
      setStatusMessage({ type: 'error', text: err.message || 'Failed to dispatch notification.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl shadow-2xl p-6 relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2.5 mb-5">
          <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shadow-sm">
            <Bell className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-900">Broadcast Push Notification</h3>
            <p className="text-xs text-slate-500">
              Instantly alert students with real-time push and in-app notices.
            </p>
          </div>
        </div>

        {statusMessage && (
          <div
            className={`mb-4 p-3.5 rounded-xl border flex items-start gap-2.5 text-xs font-semibold ${
              statusMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-rose-50 text-rose-800 border-rose-200'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Target Selector */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Audience / Recipients
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTargetType('ALL')}
                className={`py-2 px-3 rounded-lg text-xs font-bold border flex items-center justify-center gap-1.5 transition ${
                  targetType === 'ALL'
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                }`}
              >
                <Users className="w-3.5 h-3.5" /> All Students ({students.length})
              </button>
              <button
                type="button"
                onClick={() => setTargetType('SPECIFIC')}
                className={`py-2 px-3 rounded-lg text-xs font-bold border flex items-center justify-center gap-1.5 transition ${
                  targetType === 'SPECIFIC'
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                    : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                }`}
              >
                <User className="w-3.5 h-3.5" /> Specific Student
              </button>
            </div>
          </div>

          {targetType === 'SPECIFIC' && (
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
                Select Student
              </label>
              <select
                value={selectedStudentUid}
                onChange={(e) => setSelectedStudentUid(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
              >
                {students.map((st) => (
                  <option key={st.uid} value={st.uid}>
                    {st.studentId} — {st.fullName} ({st.email})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Notification Category
            </label>
            <div className="grid grid-cols-4 gap-2">
              {(['GENERAL', 'URGENT', 'ATTENDANCE', 'REMINDER'] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={`py-1.5 px-2 rounded-lg text-[11px] font-bold border text-center transition ${
                    category === cat
                      ? cat === 'URGENT'
                        ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                        : cat === 'ATTENDANCE'
                        ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                        : cat === 'REMINDER'
                        ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                        : 'bg-blue-600 text-white border-blue-600 shadow-sm'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Title *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Attendance Window Now Open / Special Session"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-700 mb-1.5">
              Message Body *
            </label>
            <textarea
              required
              rows={3}
              placeholder="Enter message text that will appear in push notifications and the in-app notice panel..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={submitting}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 font-medium resize-none"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition border border-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !message.trim()}
              className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition disabled:opacity-50 shadow-md shadow-blue-500/20 flex items-center justify-center gap-1.5"
            >
              <Send className="w-3.5 h-3.5" />
              {submitting ? 'Sending...' : 'Send Notification'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
