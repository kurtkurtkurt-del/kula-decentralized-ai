import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { normalizePassport, SUPPORTED_API, type Passport } from '@/passport/contract';

// The native module (modules/passport-measure), which runs device-passport's PassportCore.
// Absent in Expo Go, on iOS and on the web; there, and when its API is one this build does
// not know (device-passport moved on and kula did not follow yet), the JS fallback in
// data/passport.ts runs instead, so the passport tab never breaks over a version.
type Native = { measureAsync: () => Promise<string>; api?: number; schema?: string };
const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('PassportMeasure') : null;

export const nativeApi = () => native?.api ?? null;
export const nativeAvailable = () => !!native && SUPPORTED_API.includes(native.api ?? -1);
if (native && !nativeAvailable()) console.warn(`passport-core api ${native.api} is not one kula reads (${SUPPORTED_API.join(', ')}): measuring in JS`);

export async function measureNative(): Promise<Passport> {
  if (!native) throw new Error('no native passport module');
  return normalizePassport(await native.measureAsync());
}
