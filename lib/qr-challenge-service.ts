import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { INSTITUTE_CONFIG, SOLE_ADMIN_EMAIL, isAuthorizedAdmin } from './admin-config';
import { ActiveQRChallenge, ClassroomQRPayload } from './types';

export interface QRChallengeHistoryEntry {
  challengeId: string;
  status: 'ACTIVE' | 'INVALIDATED' | 'DEACTIVATED';
  generatedAt: string;
  generatedBy: string;
  invalidatedAt?: string;
}

interface ActiveQRStore {
  activeChallenge: ActiveQRChallenge;
  history: QRChallengeHistoryEntry[];
}

const DATA_DIR = path.join(process.cwd(), 'data');
const ACTIVE_QR_FILE = path.join(DATA_DIR, 'active-qr.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Creates a brand new secure QR challenge object
 */
function createChallengeRecord(adminEmail: string): ActiveQRChallenge {
  const challengeId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();

  const qrPayload: ClassroomQRPayload = {
    issuer: 'ASDC',
    type: 'classroom_attendance',
    batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
    classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
    challengeId,
    generatedAt,
  };

  return {
    challengeId,
    status: 'ACTIVE',
    batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
    issuer: 'ASDC',
    classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
    generatedAt,
    generatedBy: adminEmail || SOLE_ADMIN_EMAIL,
    qrPayload,
  };
}

/**
 * Loads the QR challenge store from disk, or initializes default
 */
export function loadQRStore(): ActiveQRStore {
  ensureDataDir();

  if (fs.existsSync(ACTIVE_QR_FILE)) {
    try {
      const raw = fs.readFileSync(ACTIVE_QR_FILE, 'utf-8');
      const parsed: ActiveQRStore = JSON.parse(raw);
      if (parsed && parsed.activeChallenge && parsed.activeChallenge.challengeId) {
        return parsed;
      }
    } catch (err) {
      console.warn('[QR Challenge Service] Error reading active-qr.json, re-initializing:', err);
    }
  }

  // Initialize new default store
  const initialChallenge = createChallengeRecord(SOLE_ADMIN_EMAIL);
  const initialStore: ActiveQRStore = {
    activeChallenge: initialChallenge,
    history: [
      {
        challengeId: initialChallenge.challengeId,
        status: 'ACTIVE',
        generatedAt: initialChallenge.generatedAt,
        generatedBy: initialChallenge.generatedBy,
      },
    ],
  };

  try {
    fs.writeFileSync(ACTIVE_QR_FILE, JSON.stringify(initialStore, null, 2), 'utf-8');
  } catch (err) {
    console.error('[QR Challenge Service] Failed to write initial active-qr.json:', err);
  }

  return initialStore;
}

/**
 * Saves the QR challenge store atomically to disk
 */
function saveQRStore(store: ActiveQRStore): void {
  ensureDataDir();
  const tempPath = `${ACTIVE_QR_FILE}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tempPath, ACTIVE_QR_FILE);
}

/**
 * Generates high-res Data URL for a given payload
 */
export async function generateQRDataUrlFromPayload(payload: ClassroomQRPayload): Promise<string> {
  const jsonString = JSON.stringify(payload);
  return await QRCode.toDataURL(jsonString, {
    width: 512,
    margin: 2,
    color: {
      dark: '#0f172a', // Navy blue
      light: '#ffffff',
    },
    errorCorrectionLevel: 'H',
  });
}

/**
 * Returns current active QR challenge and its QR image
 */
export async function getActiveQRChallenge() {
  const store = loadQRStore();
  const qrDataUrl = await generateQRDataUrlFromPayload(store.activeChallenge.qrPayload);

  return {
    challenge: store.activeChallenge,
    qrDataUrl,
    totalRefreshes: store.history.length > 0 ? store.history.length - 1 : 0,
    history: store.history,
  };
}

/**
 * Admin action: Refreshes the QR code challenge atomically.
 * Invalidates previous challenge immediately.
 */
export async function refreshQRChallenge(adminEmail: string) {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only the authorized administrator (mdausafmohiuddin@gmail.com) can refresh QR codes.');
  }

  const store = loadQRStore();
  const previousChallenge = store.activeChallenge;
  const nowIso = new Date().toISOString();

  // Invalidate previous in history
  if (previousChallenge) {
    const existingHistIdx = store.history.findIndex((h) => h.challengeId === previousChallenge.challengeId);
    if (existingHistIdx >= 0) {
      store.history[existingHistIdx].status = 'INVALIDATED';
      store.history[existingHistIdx].invalidatedAt = nowIso;
    } else {
      store.history.unshift({
        challengeId: previousChallenge.challengeId,
        status: 'INVALIDATED',
        generatedAt: previousChallenge.generatedAt,
        generatedBy: previousChallenge.generatedBy,
        invalidatedAt: nowIso,
      });
    }
  }

  // Generate brand new challenge
  const newChallenge = createChallengeRecord(adminEmail);
  store.activeChallenge = newChallenge;
  store.history.unshift({
    challengeId: newChallenge.challengeId,
    status: 'ACTIVE',
    generatedAt: newChallenge.generatedAt,
    generatedBy: adminEmail,
  });

  // Keep history to last 50 entries
  if (store.history.length > 50) {
    store.history = store.history.slice(0, 50);
  }

  // Save atomically
  saveQRStore(store);

  // Generate QR image
  const qrDataUrl = await generateQRDataUrlFromPayload(newChallenge.qrPayload);

  console.log(
    `[QR Challenge Service] QR refreshed by ${adminEmail}. New Challenge ID: ${newChallenge.challengeId}, Previous ${previousChallenge?.challengeId} invalidated.`
  );

  return {
    challenge: newChallenge,
    previousChallengeId: previousChallenge?.challengeId,
    qrDataUrl,
    totalRefreshes: store.history.length - 1,
    history: store.history,
  };
}

/**
 * Admin action: Deactivate current QR code (e.g. after class ends)
 */
export async function toggleQRChallengeActive(adminEmail: string, activate: boolean) {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only administrator can toggle QR code activation.');
  }

  const store = loadQRStore();
  store.activeChallenge.status = activate ? 'ACTIVE' : 'INACTIVE';
  saveQRStore(store);

  const qrDataUrl = await generateQRDataUrlFromPayload(store.activeChallenge.qrPayload);

  return {
    challenge: store.activeChallenge,
    qrDataUrl,
    history: store.history,
  };
}

/**
 * Validates a submitted QR challenge against the current active challenge.
 */
export function validateQRChallenge(challengeId?: string): {
  isValid: boolean;
  reason?: string;
  activeChallengeId?: string;
} {
  const store = loadQRStore();
  const current = store.activeChallenge;

  if (current.status !== 'ACTIVE') {
    return {
      isValid: false,
      reason: 'The classroom QR code is currently inactive. Please wait for the instructor to activate it.',
      activeChallengeId: current.challengeId,
    };
  }

  // If payload does not contain challengeId, it's an old legacy QR
  if (!challengeId) {
    return {
      isValid: false,
      reason: 'Outdated QR code. Please scan the current active classroom QR displayed on screen.',
      activeChallengeId: current.challengeId,
    };
  }

  if (challengeId !== current.challengeId) {
    // Check if it was an old invalidated challenge
    const wasInvalidated = store.history.some(
      (h) => h.challengeId === challengeId && h.status === 'INVALIDATED'
    );

    return {
      isValid: false,
      reason: wasInvalidated
        ? 'This QR code has been invalidated by an administrator refresh. Please scan the latest active QR code.'
        : 'Invalid QR challenge token. Please scan the official active classroom QR code.',
      activeChallengeId: current.challengeId,
    };
  }

  return {
    isValid: true,
    activeChallengeId: current.challengeId,
  };
}
