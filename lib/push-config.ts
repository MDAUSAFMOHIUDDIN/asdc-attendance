// VAPID & Push Notification Configuration
export const VAPID_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
  'BBWBrob2x2v-kg4gFzIuVdVJwVV3zMm7dXBrv4gnmBFjOI2S6mCSggQr-XBRLWBO_h2bsh6BZAd2Ky3kRrpMezo';

export const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY ||
  'DKN9Ol96PGJ8P5-QM-mwIug9vAV5TnoRTcQZzLZ3ZKo';

export const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:mdausafmohiuddin@gmail.com';
