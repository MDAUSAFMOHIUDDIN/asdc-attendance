import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SOLE_ADMIN_EMAIL, isAuthorizedAdmin } from './admin-config';
import { GeofenceConfig, LocationIncident, LocationIncidentType } from './types';

export const OFFICIAL_ASDC_LOCATION = {
  name: 'Advanced Skills Development Center (ASDC)',
  address: 'Shah Ali Banda Road, beside Masjid Aamwali, near Sultan-ul-Uloom School, Qazipura, Hyderabad, Telangana 500002, India',
  latitude: 17.34668005,
  longitude: 78.46089325,
  googleMapsUrl: 'https://maps.app.goo.gl/MfGyprjpRgzpwjsV7',
  defaultRadiusMeters: 100,
  defaultMaxAccuracyMeters: 50,
};

const DATA_DIR = path.join(process.cwd(), 'data');
const GEOFENCE_CONFIG_FILE = path.join(DATA_DIR, 'geofence-config.json');
const INCIDENTS_FILE = path.join(DATA_DIR, 'location-incidents.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Calculates accurate geodesic distance (Haversine formula) in meters
 */
export function calculateHaversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Mean Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10; // Round to 1 decimal place
}

/**
 * Loads current Geofence Configuration
 */
export function getGeofenceConfig(): GeofenceConfig {
  ensureDataDir();

  if (fs.existsSync(GEOFENCE_CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(GEOFENCE_CONFIG_FILE, 'utf-8');
      const parsed: GeofenceConfig = JSON.parse(raw);
      if (parsed && typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number') {
        return parsed;
      }
    } catch (err) {
      console.warn('[Geofence Service] Could not parse geofence-config.json, resetting to default:', err);
    }
  }

  const defaultConfig: GeofenceConfig = {
    latitude: OFFICIAL_ASDC_LOCATION.latitude,
    longitude: OFFICIAL_ASDC_LOCATION.longitude,
    radiusMeters: OFFICIAL_ASDC_LOCATION.defaultRadiusMeters,
    maxAccuracyMeters: OFFICIAL_ASDC_LOCATION.defaultMaxAccuracyMeters,
    instituteName: OFFICIAL_ASDC_LOCATION.name,
    address: OFFICIAL_ASDC_LOCATION.address,
    updatedAt: new Date().toISOString(),
    updatedBy: SOLE_ADMIN_EMAIL,
  };

  try {
    fs.writeFileSync(GEOFENCE_CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Geofence Service] Failed to save default geofence configuration:', err);
  }

  return defaultConfig;
}

/**
 * Updates Geofence Configuration (Admin only)
 */
export function updateGeofenceConfig(
  adminEmail: string,
  updates: {
    radiusMeters?: number;
    maxAccuracyMeters?: number;
    latitude?: number;
    longitude?: number;
  }
): GeofenceConfig {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only authorized administrator can update geofence configuration.');
  }

  const current = getGeofenceConfig();
  const updated: GeofenceConfig = {
    ...current,
    radiusMeters: updates.radiusMeters !== undefined ? Math.max(10, Math.min(2000, updates.radiusMeters)) : current.radiusMeters,
    maxAccuracyMeters: updates.maxAccuracyMeters !== undefined ? Math.max(10, Math.min(500, updates.maxAccuracyMeters)) : current.maxAccuracyMeters,
    latitude: updates.latitude !== undefined ? updates.latitude : current.latitude,
    longitude: updates.longitude !== undefined ? updates.longitude : current.longitude,
    updatedAt: new Date().toISOString(),
    updatedBy: adminEmail,
  };

  ensureDataDir();
  fs.writeFileSync(GEOFENCE_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export interface LocationVerificationResult {
  isValid: boolean;
  distanceMeters: number;
  errorType?: LocationIncidentType;
  message?: string;
  config: GeofenceConfig;
}

/**
 * Authoritative Backend Verification of Student Location
 */
export function verifyStudentLocation(coords?: {
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
}): LocationVerificationResult {
  const config = getGeofenceConfig();

  if (
    !coords ||
    typeof coords.latitude !== 'number' ||
    typeof coords.longitude !== 'number' ||
    isNaN(coords.latitude) ||
    isNaN(coords.longitude)
  ) {
    return {
      isValid: false,
      distanceMeters: -1,
      errorType: 'LOCATION_VERIFICATION_FAILED',
      message: 'Physical location coordinates were not provided or could not be determined.',
      config,
    };
  }

  const accuracy = typeof coords.accuracy === 'number' && !isNaN(coords.accuracy) ? coords.accuracy : 999;

  // 1. Accuracy check: prevent gross inaccuracies / spoofed or coarse IP fallbacks
  if (accuracy > config.maxAccuracyMeters) {
    return {
      isValid: false,
      distanceMeters: -1,
      errorType: 'INSUFFICIENT_LOCATION_ACCURACY',
      message: `Location accuracy (${Math.round(accuracy)}m) is too poor to verify campus presence. Maximum allowed is ${config.maxAccuracyMeters}m. Please ensure GPS/high accuracy is enabled on your device and try again.`,
      config,
    };
  }

  // 2. Geodesic distance calculation
  const distanceMeters = calculateHaversineDistance(
    config.latitude,
    config.longitude,
    coords.latitude,
    coords.longitude
  );

  // 3. Radius check
  if (distanceMeters > config.radiusMeters) {
    return {
      isValid: false,
      distanceMeters,
      errorType: 'OUTSIDE_GEOFENCE',
      message: `Outside Authorized ASDC Campus. You are approximately ${Math.round(
        distanceMeters
      )} metres away from ASDC. Attendance can only be recorded while physically present at the institute (within ${
        config.radiusMeters
      }m).`,
      config,
    };
  }

  return {
    isValid: true,
    distanceMeters,
    config,
  };
}

/**
 * Logs a security or location incident for administrator review
 */
export function logLocationIncident(
  incidentData: Omit<LocationIncident, 'id' | 'timestamp' | 'status'>
): LocationIncident {
  ensureDataDir();

  const incident: LocationIncident = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: 'New',
    ...incidentData,
  };

  let incidents: LocationIncident[] = [];
  if (fs.existsSync(INCIDENTS_FILE)) {
    try {
      incidents = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf-8'));
      if (!Array.isArray(incidents)) incidents = [];
    } catch {
      incidents = [];
    }
  }

  incidents.unshift(incident);

  // Keep last 300 incidents
  if (incidents.length > 300) {
    incidents = incidents.slice(0, 300);
  }

  try {
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Geofence Service] Failed to save incident log:', err);
  }

  return incident;
}

/**
 * Retrieves all location incidents (Admin only)
 */
export function getLocationIncidents(adminEmail: string): LocationIncident[] {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only administrator can view location incidents.');
  }

  ensureDataDir();
  if (fs.existsSync(INCIDENTS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Marks an incident as reviewed (Admin only)
 */
export function markIncidentReviewed(adminEmail: string, incidentId: string): LocationIncident[] {
  if (!isAuthorizedAdmin(adminEmail)) {
    throw new Error('Unauthorized: Only administrator can review location incidents.');
  }

  ensureDataDir();
  let incidents: LocationIncident[] = [];
  if (fs.existsSync(INCIDENTS_FILE)) {
    try {
      incidents = JSON.parse(fs.readFileSync(INCIDENTS_FILE, 'utf-8'));
    } catch {
      incidents = [];
    }
  }

  const idx = incidents.findIndex((item) => item.id === incidentId);
  if (idx >= 0) {
    incidents[idx].status = 'Reviewed';
    incidents[idx].reviewedAt = new Date().toISOString();
    incidents[idx].reviewedBy = adminEmail;
    fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2), 'utf-8');
  }

  return incidents;
}
