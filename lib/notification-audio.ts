// ASDC Attendance - Professional Notification Audio & Alert Service
// Synthesizes a clean two-tone chime via Web Audio API (0 network latency, works offline)

let audioContextInstance: AudioContext | null = null;
const playedNotificationIds = new Set<string>();

/**
 * Get or initialize the shared AudioContext
 */
export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return null;

    if (!audioContextInstance) {
      audioContextInstance = new AudioContextClass();
    }

    if (audioContextInstance.state === 'suspended') {
      audioContextInstance.resume().catch(() => {});
    }

    return audioContextInstance;
  } catch {
    return null;
  }
}

/**
 * Check if notification sound is enabled by user preference
 */
export function isNotificationAudioEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem('asdc_notification_sound_enabled') !== 'false';
}

/**
 * Set notification sound preference
 */
export function setNotificationAudioEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('asdc_notification_sound_enabled', enabled ? 'true' : 'false');
}

/**
 * Explicit user interaction handler: unlocks browser audio and plays test chime
 */
export function enableAndTestNotificationAudio(): boolean {
  if (typeof window === 'undefined') return false;
  setNotificationAudioEnabled(true);
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return playNotificationChime(`test_${Date.now()}`);
}

/**
 * Play a short, professional two-tone alert chime (E5 659.25Hz -> A5 880.00Hz)
 * De-duplicates by notification ID so duplicate push + foreground messages only chime once.
 */
export function playNotificationChime(notificationId?: string): boolean {
  if (typeof window === 'undefined') return false;

  // Prevent duplicate chime for the same notification
  if (notificationId) {
    if (playedNotificationIds.has(notificationId)) {
      return false;
    }
    playedNotificationIds.add(notificationId);
    if (playedNotificationIds.size > 150) {
      const first = playedNotificationIds.values().next().value;
      if (first) playedNotificationIds.delete(first);
    }
  }

  // Respect user sound preference
  if (!isNotificationAudioEnabled()) {
    return false;
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return false;

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Tone 1: E5 (659.25 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(659.25, now);
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(0.2, now + 0.02);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.16);

    // Tone 2: A5 (880.00 Hz)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.0, now + 0.08);
    gain2.gain.setValueAtTime(0, now + 0.08);
    gain2.gain.linearRampToValueAtTime(0.25, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.08);
    osc2.stop(now + 0.32);

    return true;
  } catch (err) {
    console.warn('[Notification Audio] Chime play note:', err);
    return false;
  }
}
