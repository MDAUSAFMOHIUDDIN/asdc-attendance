'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { Download, X, Smartphone, Share, PlusSquare, CheckCircle2, Info } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function PWAInstallBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [installedSuccessfully, setInstalledSuccessfully] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // 1. Detect if app is already running in standalone/installed mode
    const checkIsInstalled = () => {
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as any).standalone === true ||
        document.referrer.includes('android-app://') ||
        localStorage.getItem('asdc_pwa_installed') === 'true';

      setIsStandalone(standalone);
      return standalone;
    };

    if (checkIsInstalled()) {
      return;
    }

    // 2. Detect iOS Safari
    const ua = window.navigator.userAgent.toLowerCase();
    const isApple = /iphone|ipad|ipod/.test(ua);
    const isSafariBrowser = /safari/.test(ua) && !/chrome|crios|fxios|android/.test(ua);
    setIsIOS(isApple && isSafariBrowser);

    // 3. Check if user already dismissed the prompt in this session
    const isSessionDismissed = sessionStorage.getItem('asdc_install_dismissed') === 'true';

    // 4. Promptly show the installation popup on eligible visit (400ms delay for smooth mount)
    if (!isSessionDismissed) {
      const timer = setTimeout(() => {
        setShowPopup(true);
      }, 400);

      // 5. Capture native browser beforeinstallprompt event
      const handleBeforeInstallPrompt = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setShowPopup(true);
      };

      // 6. Listen for successful native app installation
      const handleAppInstalled = () => {
        setInstalledSuccessfully(true);
        setIsStandalone(true);
        setDeferredPrompt(null);
        localStorage.setItem('asdc_pwa_installed', 'true');
        setTimeout(() => {
          setShowPopup(false);
        }, 2000);
      };

      window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.addEventListener('appinstalled', handleAppInstalled);

      return () => {
        clearTimeout(timer);
        window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.removeEventListener('appinstalled', handleAppInstalled);
      };
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setShowPopup(false);
    sessionStorage.setItem('asdc_install_dismissed', 'true');
  }, []);

  const handleInstallClick = useCallback(async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          setInstalledSuccessfully(true);
          localStorage.setItem('asdc_pwa_installed', 'true');
          setDeferredPrompt(null);
          setTimeout(() => {
            setShowPopup(false);
          }, 1500);
        }
      } catch (err) {
        console.warn('Install prompt error:', err);
        setShowInstructions(true);
      }
    } else {
      // If browser doesn't support programmatic install (e.g. iOS Safari, desktop without native banner), display clear instructions
      setShowInstructions(true);
    }
  }, [deferredPrompt]);

  // Handle Escape key to dismiss without blocking
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showPopup) {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showPopup, handleDismiss]);

  // If already installed or dismissed, do not render
  if (isStandalone || !showPopup) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-fadeIn"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-2xl p-6 relative overflow-hidden animate-scaleIn transition-all">
        {/* Top Accent Ribbon */}
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500" />

        {/* Dismiss 'X' Button */}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Close installation dialog"
          className="absolute top-4 right-4 p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header with official ASDC Logo */}
        <div className="flex flex-col items-center text-center mt-2 mb-4">
          <div className="relative w-20 h-20 mb-3 bg-white border border-slate-200 rounded-2xl shadow-md p-2 flex items-center justify-center">
            <Image
              src="/asdc-logo.png"
              alt="ASDC Attendance Logo"
              width={72}
              height={72}
              className="object-contain"
              priority
            />
          </div>

          <h2 id="install-title" className="text-xl font-extrabold text-slate-950 tracking-tight">
            Install ASDC Attendance
          </h2>
          <p className="text-xs text-slate-600 mt-2 max-w-xs font-medium leading-relaxed">
            Install our app for faster and easier access to your attendance dashboard.
          </p>
        </div>

        {/* Instruction Section (shown when native prompt is unsupported or user needs guidance) */}
        {showInstructions ? (
          <div className="my-4 p-3.5 bg-blue-50/70 border border-blue-200 rounded-2xl text-left text-xs space-y-2 text-slate-700">
            <div className="flex items-center gap-2 font-bold text-blue-950 text-xs">
              <Smartphone className="w-4 h-4 text-blue-600 flex-shrink-0" />
              <span>How to install ASDC Attendance:</span>
            </div>

            {isIOS ? (
              <ol className="list-decimal pl-5 space-y-1.5 text-[11px] text-slate-700 font-medium">
                <li className="leading-snug">
                  Tap the <Share className="w-3.5 h-3.5 text-blue-600 inline mx-0.5" /> <strong>Share</strong> button at the bottom of Safari.
                </li>
                <li className="leading-snug">
                  Scroll down and tap <PlusSquare className="w-3.5 h-3.5 text-blue-600 inline mx-0.5" /> <strong>&quot;Add to Home Screen&quot;</strong>.
                </li>
                <li className="leading-snug">
                  Tap <strong>Add</strong> in the top-right corner to finish.
                </li>
              </ol>
            ) : (
              <ol className="list-decimal pl-5 space-y-1.5 text-[11px] text-slate-700 font-medium">
                <li className="leading-snug">
                  Tap the browser menu <strong>(three dots ⋮)</strong> in the top or bottom bar.
                </li>
                <li className="leading-snug">
                  Select <strong>&quot;Install App&quot;</strong> or <strong>&quot;Add to Home screen&quot;</strong>.
                </li>
                <li className="leading-snug">
                  Confirm to install the ASDC Attendance app on your device.
                </li>
              </ol>
            )}

            <button
              type="button"
              onClick={handleDismiss}
              className="w-full mt-2 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
            >
              Got it
            </button>
          </div>
        ) : (
          /* Primary Action Button Row */
          <div className="mt-5 space-y-2.5">
            <button
              type="button"
              onClick={handleInstallClick}
              disabled={installedSuccessfully}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 active:scale-[0.99] text-white rounded-2xl text-sm font-bold transition shadow-lg shadow-blue-500/25 flex items-center justify-center gap-2 disabled:opacity-75 cursor-pointer"
            >
              {installedSuccessfully ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-300" />
                  <span>APP INSTALLED!</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span>INSTALL APP</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDismiss}
              className="w-full py-2.5 px-4 text-xs font-bold text-slate-500 hover:text-slate-800 rounded-xl hover:bg-slate-50 transition cursor-pointer"
            >
              Not now
            </button>
          </div>
        )}

        {/* Feature Highlights Pills */}
        {!showInstructions && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-center gap-4 text-[11px] text-slate-500 font-medium">
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-600" /> Fast Classroom QR
            </span>
            <span className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" /> Instant Push Alerts
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
