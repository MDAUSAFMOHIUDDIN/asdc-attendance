'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Bell,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  Volume2,
  VolumeX,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  X,
  ExternalLink,
} from 'lucide-react';
import { NotificationItem } from '@/lib/types';
import {
  subscribeToNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  isPushSupported,
  getPushPermissionState,
  registerPushSubscription,
  autoRegisterPushIfPermitted,
} from '@/lib/push-notification-service';
import {
  isNotificationAudioEnabled,
  setNotificationAudioEnabled,
  enableAndTestNotificationAudio,
  playNotificationChime,
} from '@/lib/notification-audio';

interface StudentNotificationCenterProps {
  studentUid: string;
  studentName?: string;
}

export function StudentNotificationCenter({
  studentUid,
  studentName,
}: StudentNotificationCenterProps) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [filter, setFilter] = useState<'ALL' | 'UNREAD'>('ALL');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [permissionState, setPermissionState] = useState<NotificationPermission | 'unsupported'>('default');
  const [enablingPush, setEnablingPush] = useState(false);
  const [activeToast, setActiveToast] = useState<NotificationItem | null>(null);

  useEffect(() => {
    setSoundEnabled(isNotificationAudioEnabled());
    const perm = getPushPermissionState();
    setPermissionState(perm);
    if (perm === 'granted' && studentUid) {
      autoRegisterPushIfPermitted(studentUid).catch(() => {});
    }
  }, [studentUid]);

  // Handle incoming real-time notifications
  const handleNewAlert = useCallback(
    (newItem: NotificationItem) => {
      setActiveToast(newItem);
      // Auto-hide toast after 8 seconds
      const timer = setTimeout(() => {
        setActiveToast((current) => (current?.id === newItem.id ? null : current));
      }, 8000);
      return () => clearTimeout(timer);
    },
    []
  );

  useEffect(() => {
    if (!studentUid) return;

    const unsubscribe = subscribeToNotifications(
      studentUid,
      false,
      (items) => {
        setNotifications(items);
      },
      handleNewAlert
    );

    return () => unsubscribe();
  }, [studentUid, handleNewAlert]);

  const unreadNotifications = notifications.filter(
    (n) => !n.readBy || !n.readBy.includes(studentUid)
  );
  const unreadCount = unreadNotifications.length;

  const displayedNotifications =
    filter === 'UNREAD' ? unreadNotifications : notifications;

  // Toggle card expansion and auto-mark as read
  const handleCardClick = async (notif: NotificationItem) => {
    const isExpanded = expandedIds.has(notif.id);
    const newSet = new Set(expandedIds);
    if (isExpanded) {
      newSet.delete(notif.id);
    } else {
      newSet.add(notif.id);
    }
    setExpandedIds(newSet);

    // Automatically mark as read when opened/clicked
    const isUnread = !notif.readBy || !notif.readBy.includes(studentUid);
    if (isUnread) {
      await markNotificationAsRead(notif.id, studentUid);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notif.id
            ? { ...n, readBy: [...(n.readBy || []), studentUid] }
            : n
        )
      );
    }
  };

  // Mark all unread notifications as read
  const handleMarkAllRead = async () => {
    const unreadIds = unreadNotifications.map((n) => n.id);
    if (unreadIds.length === 0) return;

    await markAllNotificationsAsRead(unreadIds, studentUid);
    setNotifications((prev) =>
      prev.map((n) => ({
        ...n,
        readBy: Array.from(new Set([...(n.readBy || []), studentUid])),
      }))
    );
  };

  // Toggle sound with explicit user interaction test chime
  const handleToggleSound = () => {
    if (!soundEnabled) {
      enableAndTestNotificationAudio();
      setSoundEnabled(true);
    } else {
      setNotificationAudioEnabled(false);
      setSoundEnabled(false);
    }
  };

  const handleEnablePush = async () => {
    setEnablingPush(true);
    try {
      enableAndTestNotificationAudio();
      await registerPushSubscription(studentUid);
      setPermissionState(getPushPermissionState());
    } finally {
      setEnablingPush(false);
    }
  };

  const formatTimestamp = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return isoString;
    }
  };

  const getCategoryBadge = (category: NotificationItem['category']) => {
    switch (category) {
      case 'URGENT':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> Urgent
          </span>
        );
      case 'ATTENDANCE':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> Attendance
          </span>
        );
      case 'REMINDER':
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Reminder
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-blue-100 text-blue-800 border border-blue-200 flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> General Notice
          </span>
        );
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
      {/* Foreground Real-Time In-App Alert Toast Banner */}
      {activeToast && (
        <div className="bg-blue-600 text-white p-3.5 px-4 flex items-center justify-between gap-3 animate-fadeIn border-b border-blue-700">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
              <Bell className="w-4 h-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-bold truncate">
                New Broadcast: {activeToast.title}
              </p>
              <p className="text-[11px] text-blue-100 truncate">
                {activeToast.message}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => {
                handleCardClick(activeToast);
                setActiveToast(null);
              }}
              className="px-2.5 py-1 bg-white text-blue-700 font-bold text-xs rounded-lg hover:bg-blue-50 transition"
            >
              View
            </button>
            <button
              onClick={() => setActiveToast(null)}
              className="p-1 text-white/80 hover:text-white transition"
              aria-label="Dismiss toast"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header Bar */}
      <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm shadow-blue-500/20">
            <Bell className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-950">
                Notifications Centre
              </h2>
              {unreadCount > 0 ? (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-rose-600 text-white shadow-sm animate-pulse">
                  {unreadCount} Unread
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-600">
                  All Caught Up
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Official alerts & broadcast announcements from administration
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Sound Toggle Button */}
          <button
            type="button"
            onClick={handleToggleSound}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-bold border flex items-center gap-1.5 transition ${
              soundEnabled
                ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                : 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200'
            }`}
            title={soundEnabled ? 'Alert sounds active (click to mute)' : 'Alert sounds muted (click to enable)'}
          >
            {soundEnabled ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Sound ON</span>
              </>
            ) : (
              <>
                <VolumeX className="w-3.5 h-3.5 text-slate-400" />
                <span>Sound Muted</span>
              </>
            )}
          </button>

          {/* Mark All Read Button */}
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="px-2.5 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold border border-slate-200 transition flex items-center gap-1.5 shadow-sm"
            >
              <CheckCheck className="w-3.5 h-3.5 text-blue-600" />
              <span>Mark All as Read</span>
            </button>
          )}

          {/* Enable Push Button (if not granted) */}
          {isPushSupported() && permissionState !== 'granted' && (
            <button
              type="button"
              onClick={handleEnablePush}
              disabled={enablingPush}
              className="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition flex items-center gap-1.5 shadow-sm shadow-blue-500/20 disabled:opacity-50"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>{enablingPush ? 'Enabling...' : 'Enable Push Alerts'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabs Filter (All vs Unread) */}
      <div className="px-4 sm:px-5 py-2.5 bg-slate-50/50 border-b border-slate-100 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('ALL')}
          className={`px-3 py-1 rounded-lg text-xs font-bold transition ${
            filter === 'ALL'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          All Notifications ({notifications.length})
        </button>
        <button
          type="button"
          onClick={() => setFilter('UNREAD')}
          className={`px-3 py-1 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
            filter === 'UNREAD'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
          }`}
        >
          <span>Unread</span>
          {unreadCount > 0 && (
            <span
              className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                filter === 'UNREAD' ? 'bg-white text-blue-700' : 'bg-rose-600 text-white'
              }`}
            >
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {/* Notification List Container */}
      <div className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
        {displayedNotifications.length === 0 ? (
          <div className="py-12 px-4 text-center">
            <Bell className="w-10 h-10 mx-auto mb-2.5 text-slate-300" />
            <p className="text-sm font-bold text-slate-700">
              {filter === 'UNREAD' ? 'No unread notifications' : 'No notifications yet'}
            </p>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto font-medium">
              {filter === 'UNREAD'
                ? 'All official broadcasts have been read. Switch to "All Notifications" to view your complete history.'
                : 'Official announcements, attendance alerts, and institute updates will appear here in real time.'}
            </p>
          </div>
        ) : (
          displayedNotifications.map((notif) => {
            const isUnread = !notif.readBy || !notif.readBy.includes(studentUid);
            const isExpanded = expandedIds.has(notif.id);

            return (
              <article
                key={notif.id}
                onClick={() => handleCardClick(notif)}
                className={`p-4 sm:p-5 transition cursor-pointer flex flex-col gap-2 ${
                  isUnread
                    ? 'bg-blue-50/40 hover:bg-blue-50/70 border-l-4 border-l-blue-600'
                    : 'bg-white hover:bg-slate-50 opacity-90'
                }`}
              >
                {/* Meta Row: Category, Date, Status */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    {getCategoryBadge(notif.category)}
                    {isUnread && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-700">
                        <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                        Unread
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 font-medium">
                    {formatTimestamp(notif.createdAt)}
                  </span>
                </div>

                {/* Title */}
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className={`text-sm font-bold tracking-tight ${
                      isUnread ? 'text-slate-950 font-extrabold' : 'text-slate-800'
                    }`}
                  >
                    {notif.title}
                  </h3>
                  <button
                    type="button"
                    className="p-1 text-slate-400 hover:text-slate-600 rounded transition flex-shrink-0"
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {/* Message Body */}
                <p
                  className={`text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-medium ${
                    !isExpanded ? 'line-clamp-2' : ''
                  }`}
                >
                  {notif.message}
                </p>

                {/* Expanded Action Bar */}
                {isExpanded && notif.url && notif.url !== '/' && (
                  <div className="pt-2 flex items-center justify-between border-t border-slate-100 text-xs">
                    <a
                      href={notif.url}
                      onClick={(e) => e.stopPropagation()}
                      className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 underline"
                    >
                      <span>Open Link</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
