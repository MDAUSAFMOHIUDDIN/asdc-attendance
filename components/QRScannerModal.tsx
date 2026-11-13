'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import jsQR from 'jsqr';
import {
  Camera,
  X,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
  Sparkles,
  Upload,
  ChevronDown,
  Info,
  ExternalLink,
  Layers,
  Check,
  Copy,
  MapPin,
  MapPinOff,
  Navigation,
} from 'lucide-react';
import { StudentProfile, AttendanceRecord, ClassroomQRPayload } from '@/lib/types';
import { INSTITUTE_CONFIG, QR_ACCESS_DISABLED_MESSAGE } from '@/lib/admin-config';
import { buildClassroomQRPayload } from '@/lib/qr-generator';
import { formatDisplayDate, formatDisplayTimestamp, getISTTimeInfo } from '@/lib/date-utils';
import { auth, db } from '@/lib/firebase';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';

export type ScannerLifecycleState =
  | 'idle'
  | 'requesting-permission'
  | 'starting-camera'
  | 'scanning'
  | 'processing'
  | 'success'
  | 'already-recorded'
  | 'error';

interface CameraDevice {
  id: string;
  label: string;
}

interface DiagnosticsData {
  origin: string;
  isIframe: boolean;
  isSecureContext: boolean;
  hasMediaDevices: boolean;
  permissionQueryState: string;
  hasBarcodeDetector: boolean;
  selectedCamera: string;
  videoDimensions: string;
  activeTrackInfo: string;
  exactError: string | null;
}

export type ScannerErrorType =
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'IN_USE'
  | 'INSECURE'
  | 'IFRAME_BLOCKED'
  | 'LOCATION_DENIED'
  | 'LOCATION_OUTSIDE'
  | 'LOCATION_ACCURACY'
  | 'INVALID_QR'
  | 'QR_DISABLED'
  | 'GENERIC'
  | null;

const ASDC_COORDS = { lat: 17.34668005, lon: 78.46089325 };

function computeDistanceToASDC(lat: number, lon: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat - ASDC_COORDS.lat);
  const dLon = toRad(lon - ASDC_COORDS.lon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(ASDC_COORDS.lat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

interface QRScannerModalProps {
  student: StudentProfile;
  isOpen: boolean;
  onClose: () => void;
  onAttendanceSuccess: (record: AttendanceRecord) => void;
}

export function QRScannerModal({
  student,
  isOpen,
  onClose,
  onAttendanceSuccess,
}: QRScannerModalProps) {
  // Stable refs for external props to decouple camera lifecycle from parent re-renders
  const studentRef = useRef<StudentProfile>(student);
  const onAttendanceSuccessRef = useRef(onAttendanceSuccess);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    studentRef.current = student;
    onAttendanceSuccessRef.current = onAttendanceSuccess;
    onCloseRef.current = onClose;
  });

  // Lifecycle & UI state
  const [scannerState, setScannerState] = useState<ScannerLifecycleState>('idle');
  const [errorType, setErrorType] = useState<ScannerErrorType>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastErrorDetail, setLastErrorDetail] = useState<{ name: string; message: string } | null>(null);

  // Geolocation state
  const [locationCoords, setLocationCoords] = useState<{ latitude: number; longitude: number; accuracy: number } | null>(null);
  const [locationStatus, setLocationStatus] = useState<'idle' | 'requesting' | 'acquired' | 'denied' | 'error'>('idle');
  const [locationDistance, setLocationDistance] = useState<number | null>(null);
  const locationCoordsRef = useRef<{ latitude: number; longitude: number; accuracy: number } | null>(null);

  // Non-fatal inline scan warning (keeps camera running smoothly on invalid/mismatched QR)
  const [scanWarning, setScanWarning] = useState<string | null>(null);
  const scanWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Available camera hardware
  const [availableCameras, setAvailableCameras] = useState<CameraDevice[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>('');

  // Attendance results
  const [successRecord, setSuccessRecord] = useState<AttendanceRecord | null>(null);
  const [alreadyRecordedMessage, setAlreadyRecordedMessage] = useState<string | null>(null);

  // Diagnostics panel
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState<boolean>(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsData>({
    origin: '',
    isIframe: false,
    isSecureContext: false,
    hasMediaDevices: false,
    permissionQueryState: 'checking...',
    hasBarcodeDetector: false,
    selectedCamera: 'None',
    videoDimensions: '0 x 0',
    activeTrackInfo: 'None',
    exactError: null,
  });

  // Hardware & DOM references
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Concurrency, session token & single-flight locks
  const isStartingRef = useRef<boolean>(false);
  const isScanningRef = useRef<boolean>(false);
  const isProcessingRef = useRef<boolean>(false);
  const sessionTokenRef = useRef<number>(0);
  const animFrameRef = useRef<number | null>(null);
  const lastScanTimestampRef = useRef<number>(0);
  const lastDecodedPayloadRef = useRef<{ text: string; time: number } | null>(null);
  const barcodeDetectorRef = useRef<any>(null);

  // Initialize BarcodeDetector once on client
  useEffect(() => {
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        barcodeDetectorRef.current = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      } catch (e) {
        console.warn('[ASDC Scanner] BarcodeDetector initialization skipped:', e);
      }
    }
  }, []);

  // Update diagnostics info without invalidating effects
  const updateDiagnosticsSnapshot = useCallback(() => {
    if (typeof window === 'undefined') return;

    const isIframe = window.self !== window.top;
    const isSecureContext = Boolean(window.isSecureContext);
    const hasMediaDevices = Boolean(navigator?.mediaDevices?.getUserMedia);
    const hasBarcodeDetector = Boolean(barcodeDetectorRef.current);

    let activeTrackInfo = 'None';
    if (streamRef.current) {
      const tracks = streamRef.current.getVideoTracks();
      activeTrackInfo = tracks.map((t) => `${t.label || 'Camera'} [${t.readyState}]`).join(', ');
    }

    let videoDimensions = '0 x 0';
    if (videoRef.current) {
      videoDimensions = `${videoRef.current.videoWidth} x ${videoRef.current.videoHeight} (ReadyState: ${videoRef.current.readyState})`;
    }

    setDiagnostics({
      origin: window.location.origin,
      isIframe,
      isSecureContext,
      hasMediaDevices,
      permissionQueryState: 'Active',
      hasBarcodeDetector,
      selectedCamera: selectedCameraId || 'Automatic (Rear / Environment)',
      videoDimensions,
      activeTrackInfo,
      exactError: lastErrorDetail ? `${lastErrorDetail.name}: ${lastErrorDetail.message}` : null,
    });
  }, [selectedCameraId, lastErrorDetail]);

  // Clean up all active tracks, stream bindings, and animation frames (idempotent)
  const stopCameraResources = useCallback(() => {
    sessionTokenRef.current += 1;
    isStartingRef.current = false;
    isScanningRef.current = false;

    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
      } catch (err) {
        console.warn('[ASDC Scanner] Error stopping media tracks:', err);
      }
      streamRef.current = null;
    }

    if (videoRef.current) {
      try {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      } catch (err) {
        console.warn('[ASDC Scanner] Error clearing video srcObject:', err);
      }
    }

    if (scanWarningTimeoutRef.current) {
      clearTimeout(scanWarningTimeoutRef.current);
      scanWarningTimeoutRef.current = null;
    }
  }, []);

  // Real-Time Database Listener: Classroom QR Access ON/OFF state
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
            if (!isEnabled) {
              stopCameraResources();
              setErrorType('QR_DISABLED');
              setErrorMessage(QR_ACCESS_DISABLED_MESSAGE);
              setScannerState('error');
            }
          }
        },
        (err) => console.warn('QR scanner access listener note:', err)
      );
    } catch (err) {
      console.warn('Could not initialize scanner QR access listener:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [stopCameraResources]);

  // Show a non-fatal warning badge over the live camera preview
  const showScanWarning = useCallback((message: string) => {
    setScanWarning(message);
    if (scanWarningTimeoutRef.current) {
      clearTimeout(scanWarningTimeoutRef.current);
    }
    scanWarningTimeoutRef.current = setTimeout(() => {
      setScanWarning(null);
    }, 3500);
  }, []);

  // Geolocation acquisition
  const acquireLocation = useCallback(async (): Promise<{ latitude: number; longitude: number; accuracy: number } | null> => {
    if (typeof window === 'undefined' || !navigator.geolocation) {
      setLocationStatus('error');
      return null;
    }

    setLocationStatus('requesting');
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          locationCoordsRef.current = coords;
          setLocationCoords(coords);
          setLocationStatus('acquired');
          const dist = computeDistanceToASDC(coords.latitude, coords.longitude);
          setLocationDistance(dist);
          resolve(coords);
        },
        (err) => {
          console.warn('[ASDC Scanner] Geolocation error:', err);
          if (err.code === 1) {
            setLocationStatus('denied');
            fetch('/api/attendance/incidents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                studentId: studentRef.current.studentId,
                studentName: studentRef.current.fullName,
                studentEmail: studentRef.current.email,
                incidentType: 'LOCATION_PERMISSION_DENIED',
                details: 'Browser location permission denied by student.',
              }),
            }).catch(() => {});
          } else {
            setLocationStatus('error');
          }
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    });
  }, []);

  // Submits decoded QR payload to backend attendance route
  const handleAttendanceSubmission = useCallback(
    async (decodedText: string) => {
      // Single-flight lock
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      // Duplicate prevention: avoid resubmitting identical text within 3 seconds
      const now = Date.now();
      if (
        lastDecodedPayloadRef.current &&
        lastDecodedPayloadRef.current.text === decodedText &&
        now - lastDecodedPayloadRef.current.time < 3000
      ) {
        isProcessingRef.current = false;
        return;
      }
      lastDecodedPayloadRef.current = { text: decodedText, time: now };

      // 1. Validate payload locally before touching server or stopping camera
      let qrData: ClassroomQRPayload;
      try {
        qrData = typeof decodedText === 'string' ? JSON.parse(decodedText) : decodedText;
      } catch {
        showScanWarning('QR code is not valid JSON. Align official ASDC Classroom QR.');
        setTimeout(() => {
          isProcessingRef.current = false;
        }, 1500);
        return;
      }

      if (qrData.issuer !== 'ASDC' || qrData.type !== 'classroom_attendance') {
        showScanWarning('Unrecognized QR Code. Align the official ASDC Classroom QR.');
        setTimeout(() => {
          isProcessingRef.current = false;
        }, 1500);
        return;
      }

      if (qrData.batchId !== INSTITUTE_CONFIG.DEFAULT_BATCH_ID) {
        showScanWarning(
          `Batch mismatch: QR is for '${qrData.batchId}', but you are in '${INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}'.`
        );
        setTimeout(() => {
          isProcessingRef.current = false;
        }, 2000);
        return;
      }

      if (qrData.classroomId !== INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY) {
        showScanWarning('Classroom key mismatch. This session QR is invalid or expired.');
        setTimeout(() => {
          isProcessingRef.current = false;
        }, 2000);
        return;
      }

      // Ensure physical location is acquired before submitting
      let loc = locationCoordsRef.current;
      if (!loc) {
        loc = await acquireLocation();
      }

      if (!loc) {
        setErrorMessage(
          'Physical location permission is required to verify your presence at ASDC institute campus.'
        );
        setErrorType('LOCATION_DENIED');
        setScannerState('error');
        stopCameraResources();
        isProcessingRef.current = false;
        return;
      }

      // Valid QR payload detected! Proceed to server verification
      setScannerState('processing');
      setErrorMessage(null);
      setErrorType(null);

      try {
        const curStudent = studentRef.current;
        console.log('[ASDC Scanner] Valid QR verified. Submitting attendance for:', curStudent.studentId);

        // Get Firebase Auth ID Token for authoritative verified submission
        let idToken: string | null = null;
        try {
          if (auth.currentUser) {
            idToken = await auth.currentUser.getIdToken();
          }
        } catch {
          // Token acquisition fallback
        }

        const res = await fetch('/api/attendance/submit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            studentUid: curStudent.uid,
            studentId: curStudent.studentId,
            studentName: curStudent.fullName,
            studentEmail: curStudent.email,
            batchId: curStudent.batchId || INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
            rawQrContent: decodedText,
            location: loc,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          stopCameraResources();
          if (data.errorType === 'OUTSIDE_GEOFENCE') {
            setErrorType('LOCATION_OUTSIDE');
          } else if (data.errorType === 'INSUFFICIENT_LOCATION_ACCURACY') {
            setErrorType('LOCATION_ACCURACY');
          } else if (data.errorType === 'QR_ACCESS_DISABLED' || data.isQrDisabled) {
            setErrorType('QR_DISABLED');
          } else if (data.isExpiredChallenge) {
            setErrorType('INVALID_QR');
          } else {
            setErrorType('GENERIC');
          }
          setErrorMessage(data.error || 'Server rejected attendance submission.');
          setScannerState('error');
          return;
        }

        // Attendance authorized by backend! Stop camera resources
        stopCameraResources();

        if (data.alreadyRecorded) {
          setAlreadyRecordedMessage(data.message || 'Attendance has already been recorded for today.');
          setScannerState('already-recorded');
          if (data.record) {
            onAttendanceSuccessRef.current(data.record);
          }
          return;
        }

        // CRITICAL REQUIREMENT: Write attendance record to authoritative production database
        // and wait for successful database confirmation before displaying success to student.
        try {
          const attendanceRef = doc(db, 'attendance', data.record.id);
          await setDoc(attendanceRef, data.record);

          // Verify genuine database confirmation
          const snap = await getDoc(attendanceRef);
          if (!snap.exists()) {
            throw new Error('Database write confirmation failed: Record not found in authoritative database.');
          }

          setSuccessRecord(data.record);
          setScannerState('success');
          if (data.record) {
            onAttendanceSuccessRef.current(data.record);
          }
        } catch (dbErr: any) {
          console.error('[ASDC Scanner] Database commit error:', dbErr);
          setErrorType('GENERIC');
          setErrorMessage(
            `Database confirmation error: ${
              dbErr?.message || 'Attendance record could not be confirmed in database'
            }. Attendance was not recorded.`
          );
          setScannerState('error');
        }
      } catch (err: any) {
        console.error('[ASDC Scanner] Attendance processing error:', err);
        const msg = err instanceof Error ? err.message : 'Failed to verify classroom attendance code.';
        setErrorMessage(msg);
        setErrorType('GENERIC');
        setScannerState('error');
        stopCameraResources();
      } finally {
        isProcessingRef.current = false;
      }
    },
    [showScanWarning, stopCameraResources, acquireLocation]
  );

  // Fast, memory-efficient frame decoder
  const decodeFrame = useCallback(async (video: HTMLVideoElement): Promise<string | null> => {
    // 1. Native BarcodeDetector (hardware accelerated)
    if (barcodeDetectorRef.current) {
      try {
        const results = await barcodeDetectorRef.current.detect(video);
        if (results && results.length > 0 && results[0]?.rawValue) {
          return results[0].rawValue;
        }
      } catch {
        // Fall back to jsQR
      }
    }

    // 2. jsQR software fallback
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
    }
    const canvas = canvasRef.current;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return null;

    // Use optimal resolution (max 512px) for instant decoding without lag
    const maxDim = 512;
    const scale = Math.min(1, maxDim / Math.max(vw, vh));
    const cw = Math.floor(vw * scale);
    const ch = Math.floor(vh * scale);

    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, cw, ch);
    const imageData = ctx.getImageData(0, 0, cw, ch);
    const code = jsQR(imageData.data, cw, ch, { inversionAttempts: 'dontInvert' });

    if (code) return code.data;

    // If initial pass didn't catch it, try with inversion once
    const invertedCode = jsQR(imageData.data, cw, ch, { inversionAttempts: 'invertFirst' });
    return invertedCode ? invertedCode.data : null;
  }, []);

  // Main scanning loop: stable, throttled to 10 FPS (100ms)
  const startScanLoop = useCallback(
    (sessionId: number) => {
      isScanningRef.current = true;
      lastScanTimestampRef.current = 0;

      const tick = async (timestamp: number) => {
        // Guard against cancelled/stale sessions or closed scanner
        if (sessionTokenRef.current !== sessionId || !isScanningRef.current) {
          return;
        }

        // Throttle decoding to ~10 FPS (every 100ms)
        if (!isProcessingRef.current && timestamp - lastScanTimestampRef.current >= 100) {
          lastScanTimestampRef.current = timestamp;
          const video = videoRef.current;

          if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            try {
              const rawData = await decodeFrame(video);
              if (rawData && !isProcessingRef.current && sessionTokenRef.current === sessionId) {
                handleAttendanceSubmission(rawData);
              }
            } catch {
              // Frame decoding errors are silently ignored to keep stream smooth
            }
          }
        }

        // Schedule next frame if session remains active
        if (sessionTokenRef.current === sessionId && isScanningRef.current) {
          animFrameRef.current = requestAnimationFrame(tick);
        }
      };

      animFrameRef.current = requestAnimationFrame(tick);
    },
    [decodeFrame, handleAttendanceSubmission]
  );

  // Starts the camera stream with explicit cancellation safety
  const startCamera = useCallback(
    async (targetCameraId?: string) => {
      // 1. Single-flight lock: prevent overlapping start calls
      if (isStartingRef.current) return;
      isStartingRef.current = true;

      // 2. Increment session token for cancellation safety
      sessionTokenRef.current += 1;
      const currentSession = sessionTokenRef.current;

      console.log(`[ASDC Scanner] Session #${currentSession} starting...`);
      setErrorMessage(null);
      setErrorType(null);
      setLastErrorDetail(null);
      setScanWarning(null);
      setScannerState('requesting-permission');

      // Stop existing stream if switching
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      if (typeof window === 'undefined') {
        isStartingRef.current = false;
        return;
      }

      const isIframe = window.self !== window.top;

      if (!window.isSecureContext && window.location.hostname !== 'localhost') {
        setErrorType('INSECURE');
        setErrorMessage('Camera access requires an HTTPS secure context. Please open the application over HTTPS.');
        setScannerState('error');
        isStartingRef.current = false;
        return;
      }

      if (!navigator?.mediaDevices?.getUserMedia) {
        setErrorType('NOT_FOUND');
        setErrorMessage('navigator.mediaDevices.getUserMedia is not supported in this browser.');
        setScannerState('error');
        isStartingRef.current = false;
        return;
      }

      try {
        let stream: MediaStream | null = null;
        const chosenCameraId = targetCameraId || selectedCameraId;

        // Progressive constraint hierarchy:
        // 1. Specific selected camera
        // 2. Ideal environment (rear) camera with 1280x720 ideal
        // 3. Fallback: simple facingMode environment
        // 4. Ultimate fallback: { video: true, audio: false }
        if (chosenCameraId) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { exact: chosenCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } },
              audio: false,
            });
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({
              video: { deviceId: { ideal: chosenCameraId } },
              audio: false,
            });
          }
        } else {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            });
          } catch {
            try {
              stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false,
              });
            } catch {
              // Generic camera fallback for laptops/webcams
              stream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false,
              });
            }
          }
        }

        // CANCELLATION CHECK: discard stream if session changed while prompt was open
        if (sessionTokenRef.current !== currentSession) {
          console.log(`[ASDC Scanner] Session #${currentSession} was superseded. Cleaning up acquired stream.`);
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        setScannerState('starting-camera');

        // Handle physical camera disconnection
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            if (sessionTokenRef.current === currentSession) {
              console.warn('[ASDC Scanner] Camera track ended unexpectedly.');
              setErrorType('GENERIC');
              setErrorMessage('Camera stream ended or camera hardware was disconnected.');
              setScannerState('error');
              stopCameraResources();
            }
          };
        });

        const video = videoRef.current;
        if (!video) {
          stream.getTracks().forEach((t) => t.stop());
          isStartingRef.current = false;
          return;
        }

        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.playsInline = true;
        video.muted = true;

        try {
          await video.play();
        } catch (playErr) {
          console.warn('[ASDC Scanner] video.play() warning:', playErr);
        }

        // Wait for real frames (readyState >= 2 and dimensions > 0)
        await new Promise<void>((resolve, reject) => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            resolve();
            return;
          }

          let timeoutId: NodeJS.Timeout;
          const onReady = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('loadeddata', onReady);
            video.removeEventListener('canplay', onReady);
            resolve();
          };

          video.addEventListener('loadeddata', onReady);
          video.addEventListener('canplay', onReady);

          timeoutId = setTimeout(() => {
            video.removeEventListener('loadeddata', onReady);
            video.removeEventListener('canplay', onReady);
            if (video.videoWidth > 0) {
              resolve();
            } else {
              reject(new Error('Timed out waiting for camera video frames.'));
            }
          }, 4500);
        });

        // Final cancellation check before starting scan loop
        if (sessionTokenRef.current !== currentSession) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // Enumerate video devices once permission is active
        if (navigator?.mediaDevices?.enumerateDevices) {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter((d) => d.kind === 'videoinput');
            if (videoInputs.length > 0) {
              setAvailableCameras(
                videoInputs.map((d, index) => ({
                  id: d.deviceId,
                  label: d.label || (index === 0 ? 'Primary Camera' : `Camera ${index + 1}`),
                }))
              );
            }
          } catch (enumErr) {
            console.warn('[ASDC Scanner] Camera enumeration note:', enumErr);
          }
        }

        // Scanner is live and stable!
        setScannerState('scanning');
        console.log(`[ASDC Scanner] Session #${currentSession} active and scanning.`);
        startScanLoop(currentSession);
      } catch (err: any) {
        console.error('[ASDC Scanner] Camera startup exception:', err);
        const name = err?.name || 'Error';
        const msg = String(err?.message || err);
        setLastErrorDetail({ name, message: msg });

        if (name === 'NotAllowedError' || msg.includes('Permission') || msg.includes('denied')) {
          if (isIframe) {
            setErrorType('IFRAME_BLOCKED');
            setErrorMessage(
              'Camera access was blocked inside the preview iframe. Click "Open Direct URL" to grant camera access in a full browser tab, or use the "Upload QR Image" option.'
            );
          } else {
            setErrorType('PERMISSION');
            setErrorMessage(
              'Camera permission was denied. Tap the site/lock icon in your browser address bar to allow camera access, then tap Try Again.'
            );
          }
        } else if (name === 'NotFoundError' || msg.includes('NotFound') || msg.includes('device not found')) {
          setErrorType('NOT_FOUND');
          setErrorMessage('No camera hardware was found on this device. Please use "Upload QR Image" or test with simulation.');
        } else if (name === 'NotReadableError' || msg.includes('busy') || msg.includes('already in use')) {
          setErrorType('IN_USE');
          setErrorMessage('Camera is currently in use by another application. Please close other camera tabs and tap Try Again.');
        } else if (name === 'SecurityError') {
          setErrorType('INSECURE');
          setErrorMessage('Security restriction prevented camera access. Ensure you are connected over HTTPS.');
        } else {
          setErrorType('GENERIC');
          setErrorMessage(msg || 'Could not start camera video stream. Tap Try Again or upload a QR image.');
        }

        setScannerState('error');
        stopCameraResources();
      } finally {
        isStartingRef.current = false;
      }
    },
    [selectedCameraId, startScanLoop, stopCameraResources]
  );

  // Switch camera when user selects from dropdown
  const handleCameraChange = (newCameraId: string) => {
    setSelectedCameraId(newCameraId);
    stopCameraResources();
    setTimeout(() => {
      startCamera(newCameraId);
    }, 150);
  };

  // Image file upload fallback
  const handleImageFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMessage(null);
    setErrorType(null);
    setScannerState('processing');

    try {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to load selected image file.'));
        img.src = objectUrl;
      });

      URL.revokeObjectURL(objectUrl);

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      if (!ctx) {
        throw new Error('Canvas context could not be created for image decoding.');
      }

      ctx.drawImage(img, 0, 0);

      let decodedText: string | null = null;

      // 1. Try BarcodeDetector first
      if (barcodeDetectorRef.current) {
        try {
          const results = await barcodeDetectorRef.current.detect(canvas);
          if (results && results.length > 0 && results[0]?.rawValue) {
            decodedText = results[0].rawValue;
          }
        } catch {
          // Fallback to jsQR
        }
      }

      // 2. Try jsQR
      if (!decodedText) {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imgData.data, canvas.width, canvas.height, {
          inversionAttempts: 'dontInvert',
        });
        if (code) {
          decodedText = code.data;
        } else {
          const invertedCode = jsQR(imgData.data, canvas.width, canvas.height, {
            inversionAttempts: 'invertFirst',
          });
          if (invertedCode) {
            decodedText = invertedCode.data;
          }
        }
      }

      if (!decodedText) {
        throw new Error(
          'Could not detect a valid QR code in the uploaded photo. Ensure the QR code is clearly visible and well lit.'
        );
      }

      await handleAttendanceSubmission(decodedText);
    } catch (err: any) {
      console.warn('[ASDC Scanner] Image decode error:', err);
      setErrorMessage(err?.message || 'Error processing uploaded QR image.');
      setErrorType('GENERIC');
      setScannerState('error');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };


  // Copy diagnostics report to clipboard
  const copyDiagnostics = () => {
    updateDiagnosticsSnapshot();
    const text = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        scannerState,
        ...diagnostics,
      },
      null,
      2
    );
    navigator.clipboard.writeText(text);
    setDiagnosticsCopied(true);
    setTimeout(() => setDiagnosticsCopied(false), 2000);
  };

  // SINGLE CAMERA LIFECYCLE EFFECT
  // Mounts once when modal opens, stops once when closed or unmounted
  useEffect(() => {
    if (!isOpen) return;

    isProcessingRef.current = false;
    acquireLocation();
    const startTimer = setTimeout(() => {
      startCamera();
    }, 0);

    return () => {
      clearTimeout(startTimer);
      stopCameraResources();
    };
  }, [isOpen, startCamera, stopCameraResources, acquireLocation]);

  if (!isOpen) return null;

  const directAppUrl = typeof window !== 'undefined' ? window.location.href : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/70 backdrop-blur-sm animate-fadeIn">
      <div className="relative w-full max-w-md bg-white border border-slate-200 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-xl border border-blue-200 shadow-sm">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-extrabold text-slate-950">ASDC Classroom Scanner</h3>
              <p className="text-xs text-slate-600 font-mono font-bold">
                {student.studentId} • {student.fullName}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopCameraResources();
              onCloseRef.current();
            }}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-200 transition"
            aria-label="Close scanner"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Subheader & Location Verification */}
        <div className="px-4 sm:px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-800 font-medium flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  scannerState === 'scanning'
                    ? 'bg-emerald-500 animate-pulse'
                    : scannerState === 'error'
                    ? 'bg-rose-500'
                    : 'bg-amber-500'
                }`}
              />
              <span>
                Camera:{' '}
                <strong className="capitalize">
                  {scannerState === 'requesting-permission'
                    ? 'Permission...'
                    : scannerState === 'starting-camera'
                    ? 'Initializing...'
                    : scannerState === 'scanning'
                    ? 'Live'
                    : scannerState === 'processing'
                    ? 'Verifying...'
                    : scannerState === 'already-recorded'
                    ? 'Recorded'
                    : scannerState === 'success'
                    ? 'Done'
                    : scannerState === 'error'
                    ? 'Error'
                    : 'Idle'}
                </strong>
              </span>
            </span>

            {/* Location Badge */}
            {locationStatus === 'acquired' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                <MapPin className="w-3 h-3 text-emerald-600" />
                {locationDistance !== null ? `${locationDistance}m from ASDC` : 'Campus Verified'}
              </span>
            ) : locationStatus === 'requesting' ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200 animate-pulse">
                <Navigation className="w-3 h-3 text-amber-600 animate-spin" />
                Verifying Location...
              </span>
            ) : locationStatus === 'denied' ? (
              <button
                type="button"
                onClick={() => acquireLocation()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-200 hover:bg-rose-200 transition"
              >
                <MapPinOff className="w-3 h-3 text-rose-600" />
                Location Denied (Retry)
              </button>
            ) : (
              <button
                type="button"
                onClick={() => acquireLocation()}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-700 hover:bg-slate-300 transition"
              >
                <MapPin className="w-3 h-3" />
                Verify Location
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              updateDiagnosticsSnapshot();
              setShowDiagnostics((prev) => !prev);
            }}
            className="text-[11px] font-bold text-blue-700 hover:text-blue-900 underline flex items-center gap-1"
          >
            <Info className="w-3 h-3" />
            {showDiagnostics ? 'Hide Diagnostics' : 'Diagnostics'}
          </button>
        </div>

        {/* Diagnostics Panel */}
        {showDiagnostics && (
          <div className="p-3.5 bg-slate-900 text-slate-100 text-[11px] font-mono border-b border-slate-700 max-h-48 overflow-y-auto space-y-1">
            <div className="flex items-center justify-between border-b border-slate-800 pb-1 mb-1.5">
              <span className="font-bold text-amber-400 flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" /> Camera Diagnostics
              </span>
              <button
                type="button"
                onClick={copyDiagnostics}
                className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-white flex items-center gap-1 text-[10px]"
              >
                {diagnosticsCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {diagnosticsCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div>
              <span className="text-slate-400">Origin: </span>
              <span className="text-slate-200">{diagnostics.origin}</span>
            </div>
            <div>
              <span className="text-slate-400">Iframe Environment: </span>
              <span className={diagnostics.isIframe ? 'text-amber-300 font-bold' : 'text-emerald-400'}>
                {diagnostics.isIframe ? 'YES (Embedded Iframe - May restrict camera)' : 'NO (Top-level window)'}
              </span>
            </div>
            <div>
              <span className="text-slate-400">Secure Context (HTTPS): </span>
              <span className={diagnostics.isSecureContext ? 'text-emerald-400' : 'text-rose-400 font-bold'}>
                {diagnostics.isSecureContext ? 'YES' : 'NO (Insecure)'}
              </span>
            </div>
            <div>
              <span className="text-slate-400">Camera API: </span>
              <span className={diagnostics.hasMediaDevices ? 'text-emerald-400' : 'text-rose-400'}>
                {diagnostics.hasMediaDevices ? 'Available' : 'UNAVAILABLE'}
              </span>
            </div>
            <div>
              <span className="text-slate-400">Permission Query: </span>
              <span className="text-cyan-300">{diagnostics.permissionQueryState}</span>
            </div>
            <div>
              <span className="text-slate-400">Scanner State: </span>
              <span className="text-yellow-300 font-bold">{scannerState}</span>
            </div>
            <div>
              <span className="text-slate-400">Selected Camera: </span>
              <span className="text-slate-200">{diagnostics.selectedCamera}</span>
            </div>
            <div>
              <span className="text-slate-400">Video Dimensions: </span>
              <span className="text-slate-200">{diagnostics.videoDimensions}</span>
            </div>
            <div>
              <span className="text-slate-400">Active Tracks: </span>
              <span className="text-slate-200">{diagnostics.activeTrackInfo}</span>
            </div>
            <div>
              <span className="text-slate-400">BarcodeDetector: </span>
              <span className={diagnostics.hasBarcodeDetector ? 'text-emerald-400' : 'text-amber-300'}>
                {diagnostics.hasBarcodeDetector ? 'Native Hardware' : 'jsQR Software Fallback'}
              </span>
            </div>
            {diagnostics.exactError && (
              <div className="pt-1 text-rose-300 border-t border-slate-800">
                <span className="font-bold">Error: </span>
                {diagnostics.exactError}
              </div>
            )}
          </div>
        )}

        {/* Viewfinder and Video Area */}
        <div className="relative p-3 flex flex-col items-center justify-center min-h-[300px] bg-slate-950 overflow-hidden flex-1">
          {/* Continuous, Persistent Video Element (Never unmounted) */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="w-full max-w-[280px] sm:max-w-[300px] h-[280px] sm:h-[300px] object-cover rounded-2xl bg-black shadow-inner"
          />

          {/* Active Scanning HUD (Brackets & Guide) */}
          {scannerState === 'scanning' && (
            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-6">
              <div className="relative w-56 sm:w-60 h-56 sm:h-60 border-2 border-transparent">
                {/* 4 High-contrast Corner Brackets */}
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-blue-400 rounded-tl-xl shadow-sm" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-blue-400 rounded-tr-xl shadow-sm" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-blue-400 rounded-bl-xl shadow-sm" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-blue-400 rounded-br-xl shadow-sm" />

                {/* Subtle Scan Pulse Bar */}
                <div className="absolute left-2 right-2 top-0 h-0.5 bg-gradient-to-r from-transparent via-blue-400 to-transparent shadow-[0_0_8px_#60a5fa] animate-pulse" />
              </div>

              <div className="mt-4 px-3.5 py-1.5 rounded-full bg-slate-900/90 border border-slate-700 text-white text-xs font-semibold shadow-lg backdrop-blur-sm">
                Position ASDC Classroom QR inside frame
              </div>
            </div>
          )}

          {/* Non-fatal Floating Scan Warning Toast (keeps camera preview completely live) */}
          {scanWarning && (
            <div className="absolute top-5 left-4 right-4 z-20 flex items-center gap-2 p-2.5 bg-rose-950/90 border border-rose-500/80 text-rose-200 text-xs font-semibold rounded-xl shadow-xl backdrop-blur-sm animate-fadeIn">
              <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
              <span className="flex-1 text-[11px] leading-tight">{scanWarning}</span>
            </div>
          )}

          {/* Initializing / Permission Startup Overlay (Fades out once video is ready) */}
          {(scannerState === 'requesting-permission' || scannerState === 'starting-camera') && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-sm flex flex-col items-center justify-center z-20 text-center p-6">
              <div className="w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm font-bold text-white">
                {scannerState === 'requesting-permission' ? 'Requesting Camera Access...' : 'Starting Video Stream...'}
              </p>
              <p className="text-xs text-slate-400 mt-1 max-w-xs">
                {scannerState === 'requesting-permission'
                  ? 'Please click "Allow" on the camera permission prompt'
                  : 'Preparing high-speed QR viewfinder'}
              </p>
            </div>
          )}

          {/* Processing Submission Overlay (Smooth semi-transparent backdrop over live video) */}
          {scannerState === 'processing' && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center z-20 text-center p-6 animate-fadeIn">
              <div className="w-10 h-10 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm font-bold text-white">Verifying Classroom Code...</p>
              <p className="text-xs text-slate-400 mt-1">Recording attendance in Firestore</p>
            </div>
          )}

          {/* Success Result Overlay */}
          {scannerState === 'success' && (
            <div className="absolute inset-3 sm:inset-4 bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-5 sm:p-6 flex flex-col items-center justify-center text-center z-30 shadow-2xl animate-fadeIn">
              <CheckCircle2 className="w-12 h-12 text-emerald-600 mb-2 animate-bounce" />
              <h4 className="text-lg font-black text-emerald-950">Attendance Recorded!</h4>
              <p className="text-xs text-emerald-800 font-bold mt-1">Status: PRESENT</p>

              <div className="my-3.5 p-3 bg-white rounded-xl border border-emerald-200 text-xs w-full text-left space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">Student ID:</span>
                  <span className="font-bold font-mono text-slate-900">{student.studentId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Class Date:</span>
                  <span className="font-bold text-slate-900">
                    {formatDisplayDate(successRecord?.classDate || getISTTimeInfo().dateString)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Verified At:</span>
                  <span className="font-mono text-slate-700">
                    {formatDisplayTimestamp(successRecord?.verifiedAt || new Date().toISOString())}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  stopCameraResources();
                  onCloseRef.current();
                }}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition shadow-md"
              >
                Done
              </button>
            </div>
          )}

          {/* Already Recorded Overlay */}
          {scannerState === 'already-recorded' && (
            <div className="absolute inset-3 sm:inset-4 bg-blue-50 border-2 border-blue-300 rounded-2xl p-5 sm:p-6 flex flex-col items-center justify-center text-center z-30 shadow-2xl animate-fadeIn">
              <Sparkles className="w-12 h-12 text-blue-600 mb-2" />
              <h4 className="text-lg font-black text-blue-950">Already Verified</h4>
              <p className="text-xs text-blue-800 font-semibold mt-1 mb-4 leading-relaxed">
                {alreadyRecordedMessage || 'Your attendance has already been recorded for today.'}
              </p>
              <button
                type="button"
                onClick={() => {
                  stopCameraResources();
                  onCloseRef.current();
                }}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl transition shadow-md"
              >
                Close Scanner
              </button>
            </div>
          )}

          {/* Error & Fallback Overlay */}
          {scannerState === 'error' && (
            <div className="absolute inset-3 sm:inset-4 bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-col items-center justify-center text-center z-20 shadow-xl overflow-y-auto">
              {errorType === 'LOCATION_OUTSIDE' ? (
                <MapPinOff className="w-12 h-12 text-rose-600 mb-2 flex-shrink-0" />
              ) : errorType === 'QR_DISABLED' ? (
                <ShieldAlert className="w-12 h-12 text-rose-600 mb-2 flex-shrink-0" />
              ) : errorType === 'LOCATION_DENIED' ? (
                <MapPinOff className="w-12 h-12 text-amber-500 mb-2 flex-shrink-0" />
              ) : errorType === 'LOCATION_ACCURACY' ? (
                <Navigation className="w-12 h-12 text-amber-500 mb-2 flex-shrink-0" />
              ) : errorType === 'INVALID_QR' ? (
                <RefreshCw className="w-12 h-12 text-blue-600 mb-2 flex-shrink-0" />
              ) : errorType === 'PERMISSION' || errorType === 'IFRAME_BLOCKED' ? (
                <ShieldAlert className="w-11 h-11 text-amber-500 mb-2 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-11 h-11 text-rose-500 mb-2 flex-shrink-0" />
              )}

              <h4 className="text-sm font-extrabold text-slate-950 mb-1">
                {errorType === 'LOCATION_OUTSIDE'
                  ? 'Outside ASDC Institute Campus'
                  : errorType === 'QR_DISABLED'
                  ? 'ADMIN HAS DISABLED ATTENDANCE ACCESS'
                  : errorType === 'LOCATION_DENIED'
                  ? 'Location Permission Required'
                  : errorType === 'LOCATION_ACCURACY'
                  ? 'Low GPS Accuracy'
                  : errorType === 'INVALID_QR'
                  ? 'Classroom QR Not Recognized'
                  : errorType === 'PERMISSION'
                  ? 'Camera Permission Denied'
                  : errorType === 'IFRAME_BLOCKED'
                  ? 'Iframe Camera Access Restricted'
                  : errorType === 'NOT_FOUND'
                  ? 'No Camera Hardware Found'
                  : errorType === 'IN_USE'
                  ? 'Camera In Use'
                  : errorType === 'INSECURE'
                  ? 'HTTPS Secure Context Required'
                  : 'Scanner Notice'}
              </h4>

              <div className="text-xs leading-relaxed mb-4 max-w-sm font-medium">
                {errorType === 'QR_DISABLED' ? (
                  <div className="bg-rose-50 border border-rose-300 rounded-xl p-3.5 text-rose-950 font-bold text-center shadow-xs">
                    {QR_ACCESS_DISABLED_MESSAGE}
                  </div>
                ) : (
                  <p className="text-slate-600">{errorMessage}</p>
                )}
              </div>

              {/* Action Buttons */}
              <div className="w-full space-y-2">
                {errorType === 'QR_DISABLED' ? (
                  <button
                    type="button"
                    onClick={() => {
                      stopCameraResources();
                      onCloseRef.current();
                    }}
                    className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl shadow-md transition"
                  >
                    Close Scanner
                  </button>
                ) : errorType === 'LOCATION_OUTSIDE' || errorType === 'LOCATION_DENIED' || errorType === 'LOCATION_ACCURACY' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await acquireLocation();
                      startCamera();
                    }}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 shadow-sm transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry Location & Scan Again
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => startCamera()}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-2 shadow-sm transition"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Try Again
                  </button>
                )}

                {errorType !== 'QR_DISABLED' && (
                  <>
                    <input
                      type="file"
                      accept="image/*"
                      ref={fileInputRef}
                      onChange={handleImageFileSelect}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs rounded-xl flex items-center justify-center gap-2 border border-slate-300 transition"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Upload Photo of Classroom QR
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer: Controls & Device Switcher */}
        <div className="p-3.5 sm:p-4 border-t border-slate-200 bg-slate-50 flex flex-col gap-2.5 flex-shrink-0">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-xs">
            {availableCameras.length > 1 ? (
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <span className="text-slate-600 font-bold text-[11px] whitespace-nowrap">Camera:</span>
                <div className="relative flex-1 sm:w-48">
                  <select
                    value={selectedCameraId}
                    onChange={(e) => handleCameraChange(e.target.value)}
                    className="w-full appearance-none pl-3 pr-8 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                  >
                    {availableCameras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-2 pointer-events-none" />
                </div>
              </div>
            ) : (
              <span className="text-slate-600 text-xs font-medium flex items-center gap-1.5">
                <span
                  className={`w-2 h-2 rounded-full ${
                    scannerState === 'scanning' ? 'bg-emerald-500' : 'bg-slate-400'
                  }`}
                />
                {scannerState === 'scanning' ? 'Camera active & streaming' : 'Scanner ready'}
              </span>
            )}

            {/* Quick Upload Action */}
            <div className="flex items-center gap-2">
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageFileSelect}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-xs font-bold text-blue-700 hover:text-blue-900 underline flex items-center gap-1"
              >
                <Upload className="w-3 h-3" />
                Upload QR Image
              </button>
            </div>
          </div>

          <p className="text-[11px] text-slate-500 leading-normal font-medium text-center sm:text-left">
            Align the official ASDC classroom QR code inside the viewfinder. Attendance records automatically on detection.
          </p>
        </div>
      </div>
    </div>
  );
}
