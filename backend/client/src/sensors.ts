//
//  sensors.ts
//  HIVE (client)
//
//  Reading the phone's motion sensors, the same way on both platforms.
//
//  `devicemotion` is the only sensor event iOS Safari and Android Chrome share.
//  It fires at about 60 Hz on both, with acceleration in m/s² and rotation
//  rate in °/s. Three platform differences are absorbed here so nothing
//  downstream has to know: iOS wants an explicit permission from a tap, iOS
//  reports gravity with the opposite sign, and iOS ≥ 16.4 / Android need a
//  wake lock or the screen sleeps and the events stop.
//

import type { Platform } from '../../shared/types';

export type Support = 'ok' | 'insecure' | 'unsupported';
export type Permission = 'granted' | 'denied' | 'prompt';

export interface MotionSample {
  /** Epoch ms, from the event's high-resolution timestamp. */
  t: number;
  ax: number; ay: number; az: number;
  gx: number; gy: number; gz: number;
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  // iPadOS 13+ presents as a desktop browser; desktop devices have no touch points.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

export function checkSupport(): Support {
  if (!window.isSecureContext) return 'insecure';
  if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
  return 'ok';
}

type RequestPermission = { requestPermission?: () => Promise<Permission> };

/** Must run inside a user gesture on iOS. Resolves 'granted' where no prompt exists. */
export async function requestMotionPermission(): Promise<Permission> {
  const dme = DeviceMotionEvent as unknown as RequestPermission;
  if (typeof dme.requestPermission !== 'function') return 'granted';
  try {
    return await dme.requestPermission();
  } catch (err) {
    // NotAllowedError without transient activation, or a user who dismissed
    // the sheet — both read as "not now".
    console.warn('[hive] requestPermission:', err);
    return 'denied';
  }
}

export interface MotionStream {
  stop: () => void;
}

/**
 * Starts listening. `onSample` is called for every event with normalized
 * values; `onSilence` if nothing arrives within two seconds (a laptop, or a
 * denied permission that did not throw).
 */
export function startMotion(
  platform: Platform,
  onSample: (s: MotionSample) => void,
  onSilence: () => void,
): MotionStream {
  // Flat, screen up: Android reads z ≈ +9.81, iOS reads z ≈ −9.81. Normalize to Android/spec.
  const sign = platform === 'ios' ? -1 : 1;
  // event.timeStamp is DOMHighResTimeStamp relative to timeOrigin on modern browsers.
  const origin = performance.timeOrigin;
  let received = false;

  const handler = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    if (!a && !r) return;
    received = true;
    onSample({
      t: origin + e.timeStamp,
      ax: sign * (a?.x ?? 0), ay: sign * (a?.y ?? 0), az: sign * (a?.z ?? 0),
      // rotationRate: alpha about z, beta about x, gamma about y → reorder to x, y, z.
      gx: r?.beta ?? 0, gy: r?.gamma ?? 0, gz: r?.alpha ?? 0,
    });
  };

  window.addEventListener('devicemotion', handler);
  const silence = setTimeout(() => { if (!received) onSilence(); }, 2000);

  return {
    stop: () => {
      clearTimeout(silence);
      window.removeEventListener('devicemotion', handler);
    },
  };
}

// --- wake lock ------------------------------------------------------------------

let sentinel: WakeLockSentinel | null = null;

export async function keepAwake(): Promise<boolean> {
  if (!('wakeLock' in navigator)) return false;
  try {
    sentinel?.release().catch(() => undefined);
    sentinel = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    return false;
  }
}

export function releaseWake(): void {
  sentinel?.release().catch(() => undefined);
  sentinel = null;
}
