import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { INSTITUTE_CONFIG, SOLE_ADMIN_EMAIL, isAuthorizedAdmin, QR_ACCESS_DISABLED_MESSAGE } from './admin-config.ts';
import type { ActiveQRChallenge, ClassroomQRPayload, QRAccessStatus } from './types.ts';
import { OFFICIAL_PERMANENT_QR_PAYLOAD, generateClassroomQRDataUrl } from './qr-generator.ts';
import { db } from './firebase.ts';
import { doc, getDoc, setDoc } from 'firebase/firestore';

/**
 * ASDC Attendance - Permanent Classroom QR Service & Admin Access Controller
 * 
 * Rules:
 * 1. ONE permanent, original classroom QR code for ASDC. NO regeneration, NO daily expiration.
 * 2. Admin ON/OFF Control: ENABLE QR ACCESS / DISABLE QR ACCESS.
 * 3. Status stored in Firestore ('settings/qr_access') and persisted to disk.
 * 4. Only mdausafmohiuddin@gmail.com can change access status.
 */

const DATA_DIR = path.join(process.cwd(), 'data');
const QR_ACCESS_FILE = path.join(DATA_DIR, 'qr-access.json');
const ACTIVE_QR_FILE = path.join(DATA_DIR, 'active-qr.json');

function ensureDataDir(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch {
    // In serverless read-only environments, ignore mkdir errors
  }
}

// In-memory cache for ultra-fast checks and serverless warm starts
let inMemoryQRAccessStatus: QRAccessStatus = 'ENABLED';
let inMemoryQRAccessEnabled = true;
let lastStatusFetchedAt = 0;

export { QR_ACCESS_DISABLED_MESSAGE };

/**
 * Authoritative Backend Query: Get current QR Access boolean state (qrAccessEnabled)
 */
export async function isQRAccessEnabled(forceFresh = false): Promise<boolean> {
  const status = await getQRAccessStatus(forceFresh);
  return status === 'ENABLED';
}

/**
 * Authoritative Backend Query: Get current QR Access status (ENABLED | DISABLED)
 */
export async function getQRAccessStatus(forceFresh = false): Promise<QRAccessStatus> {
  const now = Date.now();
  // If not forcing fresh, cache for 1.5 seconds to avoid excessive disk/network on rapid scans
  if (!forceFresh && now - lastStatusFetchedAt < 1500) {
    return inMemoryQRAccessStatus;
  }

  // 1. Try reading from Firestore settings/qr_access
  try {
    const settingRef = doc(db, 'settings', 'qr_access');
    const snap = await getDoc(settingRef);
    if (snap.exists()) {
      const data = snap.data();
      if (data) {
        if (typeof data.qrAccessEnabled === 'boolean') {
          inMemoryQRAccessEnabled = data.qrAccessEnabled;
          inMemoryQRAccessStatus = data.qrAccessEnabled ? 'ENABLED' : 'DISABLED';
          lastStatusFetchedAt = now;
          return inMemoryQRAccessStatus;
        }
        if (data.status === 'ENABLED' || data.status === 'DISABLED') {
          inMemoryQRAccessStatus = data.status;
          inMemoryQRAccessEnabled = data.status === 'ENABLED';
          lastStatusFetchedAt = now;
          return inMemoryQRAccessStatus;
        }
      }
    }
  } catch (err) {
    // Firestore read error or unauthenticated: fall back to local disk
  }

  // 2. Fall back to local file
  ensureDataDir();
  if (fs.existsSync(QR_ACCESS_FILE)) {
    try {
      const raw = fs.readFileSync(QR_ACCESS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.qrAccessEnabled === 'boolean') {
        inMemoryQRAccessEnabled = parsed.qrAccessEnabled;
        inMemoryQRAccessStatus = parsed.qrAccessEnabled ? 'ENABLED' : 'DISABLED';
        lastStatusFetchedAt = now;
        return inMemoryQRAccessStatus;
      }
      if (parsed?.status === 'ENABLED' || parsed?.status === 'DISABLED') {
        inMemoryQRAccessStatus = parsed.status;
        inMemoryQRAccessEnabled = parsed.status === 'ENABLED';
        lastStatusFetchedAt = now;
        return inMemoryQRAccessStatus;
      }
    } catch {
      // Ignore parse error
    }
  }

  // 3. Fall back to active-qr.json if present
  if (fs.existsSync(ACTIVE_QR_FILE)) {
    try {
      const raw = fs.readFileSync(ACTIVE_QR_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.activeChallenge?.status === 'INACTIVE' || parsed?.status === 'DISABLED' || parsed?.qrAccessEnabled === false) {
        inMemoryQRAccessStatus = 'DISABLED';
        inMemoryQRAccessEnabled = false;
      } else {
        inMemoryQRAccessStatus = 'ENABLED';
        inMemoryQRAccessEnabled = true;
      }
      lastStatusFetchedAt = now;
      return inMemoryQRAccessStatus;
    } catch {
      // Ignore parse error
    }
  }

  // Default initial status is ENABLED
  inMemoryQRAccessStatus = 'ENABLED';
  inMemoryQRAccessEnabled = true;
  lastStatusFetchedAt = now;
  return 'ENABLED';
}

/**
 * Authoritative Admin Mutation: Enable or Disable Classroom QR Access
 * Only mdausafmohiuddin@gmail.com is authorized.
 */
export async function setQRAccessStatus(
  adminEmail: string,
  newStatusOrEnabled: QRAccessStatus | boolean
): Promise<{ success: boolean; status: QRAccessStatus; qrAccessEnabled: boolean; updatedAt: string }> {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only authorized administrator (mdausafmohiuddin@gmail.com) can change QR access.');
  }

  const isEnabled = typeof newStatusOrEnabled === 'boolean' ? newStatusOrEnabled : newStatusOrEnabled === 'ENABLED';
  const newStatus: QRAccessStatus = isEnabled ? 'ENABLED' : 'DISABLED';
  const nowIso = new Date().toISOString();

  inMemoryQRAccessStatus = newStatus;
  inMemoryQRAccessEnabled = isEnabled;
  lastStatusFetchedAt = Date.now();

  const accessRecord = {
    qrAccessEnabled: isEnabled,
    status: newStatus,
    updatedAt: nowIso,
    updatedBy: adminEmail,
  };

  // 1. Update Firestore doc settings/qr_access
  try {
    const settingRef = doc(db, 'settings', 'qr_access');
    await setDoc(settingRef, accessRecord, { merge: true });
  } catch (err) {
    console.warn('[QR Service] Firestore status write notice:', err);
  }

  // 2. Persist to local disk
  ensureDataDir();
  try {
    fs.writeFileSync(QR_ACCESS_FILE, JSON.stringify(accessRecord, null, 2), 'utf-8');
    // Also keep active-qr.json in sync for legacy compatibility
    const activeLegacy = {
      activeChallenge: {
        challengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
        status: isEnabled ? 'ACTIVE' : 'INACTIVE',
        batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
        issuer: 'ASDC',
        classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
        generatedAt: '2026-10-19T00:00:00.000Z',
        generatedBy: SOLE_ADMIN_EMAIL,
        qrPayload: OFFICIAL_PERMANENT_QR_PAYLOAD,
      },
      qrAccessEnabled: isEnabled,
      status: newStatus,
      updatedAt: nowIso,
    };
    fs.writeFileSync(ACTIVE_QR_FILE, JSON.stringify(activeLegacy, null, 2), 'utf-8');
  } catch (err) {
    // In read-only serverless, file write might fail
  }

  console.log(`[QR Service] Classroom QR Access updated to ${newStatus} (qrAccessEnabled: ${isEnabled}) by ${adminEmail}`);

  return {
    success: true,
    status: newStatus,
    qrAccessEnabled: isEnabled,
    updatedAt: nowIso,
  };
}

/**
 * Validates whether classroom attendance QR is valid and currently accepted.
 */
export async function validateClassroomQR(qrPayload: any): Promise<{
  isValid: boolean;
  reason?: string;
  isQrDisabled?: boolean;
}> {
  // 1. Check Backend QR Access ON/OFF status first
  const accessStatus = await getQRAccessStatus();
  if (accessStatus === 'DISABLED') {
    return {
      isValid: false,
      isQrDisabled: true,
      reason: QR_ACCESS_DISABLED_MESSAGE,
    };
  }

  // 2. Validate payload structure
  if (!qrPayload || typeof qrPayload !== 'object') {
    return {
      isValid: false,
      reason: 'Invalid QR code. The scanned QR is not valid classroom attendance data.',
    };
  }

  if (
    qrPayload.issuer !== 'ASDC' ||
    qrPayload.type !== 'classroom_attendance' ||
    qrPayload.classroomId !== INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY
  ) {
    return {
      isValid: false,
      reason: 'Invalid Classroom QR. Scanned QR code does not match official ASDC AI Builder Mastery classroom.',
    };
  }

  if (qrPayload.batchId !== INSTITUTE_CONFIG.DEFAULT_BATCH_ID) {
    return {
      isValid: false,
      reason: `Unauthorized Batch: Only students enrolled in '${INSTITUTE_CONFIG.DEFAULT_BATCH_NAME}' may submit attendance.`,
    };
  }

  return { isValid: true };
}

/**
 * Returns current active permanent QR information and access status
 */
export async function getActiveQRChallenge() {
  const status = await getQRAccessStatus();
  const qrDataUrl = await generateClassroomQRDataUrl();

  const challenge: ActiveQRChallenge = {
    challengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
    status: status === 'ENABLED' ? 'ACTIVE' : 'INACTIVE',
    batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
    issuer: 'ASDC',
    classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
    generatedAt: '2026-10-19T00:00:00.000Z',
    generatedBy: SOLE_ADMIN_EMAIL,
    qrPayload: OFFICIAL_PERMANENT_QR_PAYLOAD,
  };

  return {
    challenge,
    qrDataUrl,
    qrAccessStatus: status,
    qrAccessEnabled: status === 'ENABLED',
    isPermanent: true,
    totalRefreshes: 0,
    history: [],
  };
}

/**
 * Legacy compatibility: validateQRChallenge
 */
export function validateQRChallenge(challengeId?: string): {
  isValid: boolean;
  reason?: string;
  activeChallengeId?: string;
  isQrDisabled?: boolean;
} {
  // If memory status says disabled
  if (inMemoryQRAccessStatus === 'DISABLED' || !inMemoryQRAccessEnabled) {
    return {
      isValid: false,
      isQrDisabled: true,
      reason: QR_ACCESS_DISABLED_MESSAGE,
      activeChallengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
    };
  }

  // The permanent QR is always valid
  return {
    isValid: true,
    activeChallengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
  };
}

/**
 * Legacy compatibility: toggleQRChallengeActive
 */
export async function toggleQRChallengeActive(adminEmail: string, activate: boolean) {
  const result = await setQRAccessStatus(adminEmail, activate ? 'ENABLED' : 'DISABLED');
  const qrDataUrl = await generateClassroomQRDataUrl();
  return {
    challenge: {
      challengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
      status: result.status === 'ENABLED' ? 'ACTIVE' : 'INACTIVE',
      batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
      issuer: 'ASDC',
      classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
      generatedAt: '2026-10-19T00:00:00.000Z',
      generatedBy: adminEmail,
      qrPayload: OFFICIAL_PERMANENT_QR_PAYLOAD,
    },
    qrAccessStatus: result.status,
    qrDataUrl,
    history: [],
  };
}

/**
 * Legacy compatibility: refreshQRChallenge
 * As requested: NO regeneration. Returns the permanent QR code.
 */
export async function refreshQRChallenge(adminEmail: string) {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only authorized administrator can access classroom QR.');
  }

  const qrDataUrl = await generateClassroomQRDataUrl();
  const status = await getQRAccessStatus();

  return {
    challenge: {
      challengeId: 'ASDC_OFFICIAL_PERMANENT_QR',
      status: status === 'ENABLED' ? 'ACTIVE' : 'INACTIVE',
      batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
      issuer: 'ASDC',
      classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
      generatedAt: '2026-10-19T00:00:00.000Z',
      generatedBy: adminEmail,
      qrPayload: OFFICIAL_PERMANENT_QR_PAYLOAD,
    },
    qrAccessStatus: status,
    qrDataUrl,
    isPermanent: true,
    totalRefreshes: 0,
    history: [],
    message: 'Official ASDC classroom QR code is permanent and static.',
  };
}
