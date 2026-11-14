'use client';

import React, { useState, useEffect } from 'react';
import {
  Bell,
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  Volume2,
  Calendar,
  Send,
} from 'lucide-react';
import { NotificationItem } from '@/lib/types';
import {
  subscribeToNotifications,
  markNotificationAsRead,
  isPushSupported,
  getPushPermissionState,
  registerPushSubscription,
} from '@/lib/push-notification-service';

interface NotificationPanelProps {
  userUid: string;
  isAdmin?: boolean;
}

export function NotificationPanel({ userUid, isAdmin = false }: NotificationPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [permissionState, setPermissionState] = useState<NotificationPermission | 'unsupported'>('default');
  const [enablingPush, setEnablingPush] = useState(false);

  useEffect(() => {
    setPermissionState(getPushPermissionState());

    if (!userUid) return;

    const unsubscribe = subscribeToNotifications(userUid, isAdmin, (items) => {
      setNotifications(items);
    });

    return () => unsubscribe();
  }, [userUid, isAdmin]);

  const handleEnablePush = async () => {
    setEnablingPush(true);
    try {
      await registerPushSubscription(userUid);
      setPermissionState(getPushPermissionState());
    } finally {
      setEnablingPush(false);
    }
  };

  const unreadCount = notifications.filter(
    (n) => !n.readBy || !n.readBy.includes(userUid)
  ).length;

  const handleMarkAsRead = async (notifId: string) => {
    await markNotificationAsRead(notifId, userUid);
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === notifId
          ? { ...n, readBy: [...(n.readBy || []), userUid] }
          : n
      )
    );
  };

  const getCategoryBadge = (category: NotificationItem['category']) => {
    switch (category) {
      case 'URGENT':
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
            <AlertCircle className="w-2.5 h-2.5" /> Urgent
          </span>
        );
      case 'ATTENDANCE':
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
            <CheckCircle2 className="w-2.5 h-2.5" /> Attendance
          </span>
        );
      case 'REMINDER':
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" /> Reminder
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" /> Notice
          </span>
        );
    }
  };

  const formatTimestamp = (isoString: string) => {
    try {
      const date = new Date(isoString);
      return date.toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <>
      {/* Bell Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="relative p-2 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 border border-slate-200 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="View notifications"
        title="Official Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 bg-rose-600 text-white font-bold text-[10px] rounded-full flex items-center justify-center shadow-sm animate-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Slide-over / Modal Panel */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-sm animate-fadeIn">
          <div className="w-full max-w-md bg-white h-full shadow-2xl flex flex-col border-l border-slate-200">
            {/* Header */}
            <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-sm shadow-blue-500/20">
                  <Bell className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Notifications</h3>
                  <p className="text-xs text-slate-500">Official Institute Announcements</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Push Notification Activation Banner */}
            {isPushSupported() && permissionState !== 'granted' && (
              <div className="p-3.5 bg-blue-50/70 border-b border-blue-200 flex items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 text-blue-900">
                  <Volume2 className="w-4 h-4 text-blue-600 flex-shrink-0" />
                  <span>Get real-time attendance and schedule alerts on your device.</span>
                </div>
                <button
                  type="button"
                  onClick={handleEnablePush}
                  disabled={enablingPush}
                  className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-[11px] whitespace-nowrap transition shadow-sm disabled:opacity-50"
                >
                  {enablingPush ? 'Enabling...' : 'Enable Push'}
                </button>
              </div>
            )}

            {permissionState === 'granted' && (
              <div className="px-4 py-2 bg-emerald-50/50 border-b border-emerald-100 flex items-center gap-2 text-[11px] text-emerald-800 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>Web Push Notifications Active</span>
              </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {notifications.length === 0 ? (
                <div className="py-16 text-center text-slate-400">
                  <Bell className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p className="text-sm font-semibold text-slate-600">No notifications yet</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Official announcements from ASDC administration will appear here.
                  </p>
                </div>
              ) : (
                notifications.map((notif) => {
                  const isRead = notif.readBy?.includes(userUid);
                  return (
                    <div
                      key={notif.id}
                      className={`p-3.5 rounded-xl border transition ${
                        isRead
                          ? 'bg-white border-slate-200 opacity-80'
                          : 'bg-blue-50/30 border-blue-200 shadow-sm'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        {getCategoryBadge(notif.category)}
                        <span className="text-[10px] text-slate-400 font-mono">
                          {formatTimestamp(notif.createdAt)}
                        </span>
                      </div>

                      <h4 className="text-xs font-bold text-slate-900 mb-1">
                        {notif.title}
                      </h4>
                      <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-line mb-2">
                        {notif.message}
                      </p>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-[10px] text-slate-400">
                        <span>ASDC Admin</span>
                        {!isRead && (
                          <button
                            type="button"
                            onClick={() => handleMarkAsRead(notif.id)}
                            className="text-blue-600 hover:text-blue-700 font-bold hover:underline"
                          >
                            Mark as read
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="p-3 border-t border-slate-200 text-center text-[11px] text-slate-400 bg-slate-50/50">
              ASDC Institutional Notification Center
            </div>
          </div>
        </div>
      )}
    </>
  );
}
