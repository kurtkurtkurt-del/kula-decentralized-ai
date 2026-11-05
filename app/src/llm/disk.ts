import { Paths } from 'expo-file-system';

// Free space before a download. expo-file-system (SDK 57) exposes it as a synchronous
// getter in bytes; the native module's info() has the same number for the app's files dir.
// Either can be missing (web, Expo Go without the module), so this never throws.
export function freeDiskBytes(): number | null {
  try {
    const b = Paths.availableDiskSpace;
    return Number.isFinite(b) && b > 0 ? b : null;
  } catch {
    return null;
  }
}

/** Room a download of `size` bytes leaves, after a 200 MB margin for the system; null when unknown. */
export const KEEP_FREE = 200 * 1024 * 1024;
export function roomFor(size: number, free: number | null = freeDiskBytes()): boolean | null {
  if (free === null) return null;
  return free - size >= KEEP_FREE;
}
