import QRCode from 'qrcode';
import { INSTITUTE_CONFIG } from './admin-config.ts';
import type { ClassroomQRPayload } from './types.ts';

/**
 * ASDC Attendance - Canonical Permanent Classroom QR Code
 * 
 * ONE permanent, original classroom QR code for ASDC.
 * This payload is static, immutable, and NEVER regenerates or expires.
 */
export const OFFICIAL_PERMANENT_QR_PAYLOAD: ClassroomQRPayload = {
  issuer: 'ASDC',
  type: 'classroom_attendance',
  batchId: INSTITUTE_CONFIG.DEFAULT_BATCH_ID,
  classroomId: INSTITUTE_CONFIG.CLASSROOM_SECRET_KEY,
  permanentId: 'ASDC_PERMANENT_CLASSROOM_QR',
  institute: 'Advanced Skills Development Center (ASDC)',
};

let cachedPermanentQRDataUrl: string | null = null;

/**
 * Creates the official ASDC Classroom QR payload (static & permanent)
 */
export function buildClassroomQRPayload(): ClassroomQRPayload {
  return OFFICIAL_PERMANENT_QR_PAYLOAD;
}

/**
 * Generates high-resolution QR Code Data URL (PNG) for printing or display.
 * Purely deterministic: produces the exact same QR image indefinitely.
 */
export async function generateClassroomQRDataUrl(): Promise<string> {
  if (cachedPermanentQRDataUrl) {
    return cachedPermanentQRDataUrl;
  }

  const jsonString = JSON.stringify(OFFICIAL_PERMANENT_QR_PAYLOAD);

  try {
    const dataUrl = await QRCode.toDataURL(jsonString, {
      width: 512,
      margin: 2,
      color: {
        dark: '#0f172a', // Navy blue
        light: '#ffffff',
      },
      errorCorrectionLevel: 'H',
    });
    cachedPermanentQRDataUrl = dataUrl;
    return dataUrl;
  } catch (err) {
    console.error('Failed to generate QR data URL:', err);
    throw err;
  }
}
