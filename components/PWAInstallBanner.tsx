'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { Download, X, Smartphone, Share, PlusSquare, Check } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isDismissed, setIsDismissed] = useState(true); // default hidden until checked
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [installedSuccessfully, setInstalledSuccessfully] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // 1. Detect if running as standalone installed PWA
    const checkStandalone = () => {
      const isStandaloneMode =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true ||
        document.referrer.includes('android-app://');
      setIsStandalone(isStandaloneMode);
      return isStandaloneMode;
    };

    if (checkStandalone()) return;

    // 2. Check dismissal memory (expires after 24 hours so it reappears if not installed)
    const dismissedAt = localStorage.getItem('asdc_pwa_dismissed_at');
    if (dismissedAt) {
      const elapsed = Date.now() - parseInt(dismissedAt, 10);
      if (elapsed < 24 * 60 * 60 * 1000) {
        setIsDismissed(true);
      } else {
        setIsDismissed(false);
      }
    } else {
      setIsDismissed(false);
    }

    // 3. Detect iOS Safari
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod/.test(userAgent);
    const isSafari = /safari/.test(userAgent) && !/chrome|crios|fxios/.test(userAgent);
    setIsIOS(isAppleDevice && isSafari);

    // 4. Capture native beforeinstallprompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setIsDismissed(false);
    };

    // 5. Detect app installed event
    const handleAppInstalled = () => {
      setInstalledSuccessfully(true);
      setIsStandalone(true);
      setDeferredPrompt(null);
      localStorage.setItem('asdc_pwa_installed', 'true');
      setTimeout(() => {
        setIsDismissed(true);
      }, 3000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = useCallback(async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          setInstalledSuccessfully(true);
          setDeferredPrompt(null);
        }
      } catch (err) {
        console.warn('Install prompt error:', err);
      }
    } else if (isIOS) {
      setShowIOSInstructions(true);
    } else {
      // Browser doesn't support programmatic install
      setShowIOSInstructions(true);
    }
  }, [deferredPrompt, isIOS]);

  const handleDismiss = useCallback(() => {
    setIsDismissed(true);
    localStorage.setItem('asdc_pwa_dismissed_at', Date.now().toString());
  }, []);

  // Do not show if already in standalone app, or dismissed
  if (isStandalone || isDismissed) {
    return null;
  }

  return (
    <aside
      aria-label="App Installation"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-md z-50 bg-white border border-blue-200/80 rounded-2xl p-4 shadow-2xl backdrop-blur-md bg-white/95 animate-in slide-in-from-bottom duration-300"
    >
      <div className="flex items-start gap-3.5">
        {/* App Logo */}
        <div className="relative w-12 h-12 flex-shrink-0 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm p-1">
          <Image
            src="/asdc-logo.png"
            alt="ASDC Attendance Logo"
            fill
            sizes="48px"
            className="object-contain p-0.5"
            priority
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-1">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 tracking-tight flex items-center gap-1.5">
              Install ASDC Attendance
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
                App
              </span>
            </h3>
            <button
              onClick={handleDismiss}
              aria-label="Dismiss install invitation"
              className="text-slate-400 hover:text-slate-600 p-1 -mr-1 rounded-lg transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-600 mt-0.5 leading-snug">
            Get faster access to your attendance dashboard with the ASDC Attendance app.
          </p>

          {/* Action Row */}
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleInstallClick}
              disabled={installedSuccessfully}
              className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm shadow-blue-500/20"
            >
              {installedSuccessfully ? (
                <>
                  <Check className="w-3.5 h-3.5" /> Installed!
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" /> INSTALL APP
                </>
              )}
            </button>

            <button
              onClick={handleDismiss}
              className="px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:text-slate-700 transition"
            >
              Not now
            </button>
          </div>
        </div>
      </div>

      {/* iOS Safari Instructions Accordion / Sheet */}
      {showIOSInstructions && (
        <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-700 bg-slate-50 rounded-xl p-3">
          <p className="font-bold text-slate-900 mb-1.5 flex items-center gap-1.5">
            <Smartphone className="w-4 h-4 text-blue-600" />
            Install on your device:
          </p>
          <ol className="list-decimal pl-4 space-y-1 text-slate-600 text-[11px]">
            <li className="flex items-center gap-1">
              Tap the <Share className="w-3 h-3 text-blue-600 inline" /> Share button in browser bar.
            </li>
            <li className="flex items-center gap-1">
              Scroll down and select <PlusSquare className="w-3 h-3 text-blue-600 inline" />{' '}
              <strong className="text-slate-900">&quot;Add to Home Screen&quot;</strong>.
            </li>
            <li>Tap &quot;Add&quot; in the top-right corner.</li>
          </ol>
        </div>
      )}
    </aside>
  );
}
