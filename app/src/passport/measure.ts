import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { Passport } from '@/data/passport';

// The native module (modules/passport-measure, Kotlin). Absent in Expo Go, on iOS and
// on the web: the JS fallback in data/passport.ts runs instead.
type Native = { measureAsync: () => Promise<string> };
const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('PassportMeasure') : null;

export const nativeAvailable = () => !!native;
export async function measureNative(): Promise<Passport> {
  if (!native) throw new Error('no native passport module');
  const json = await native.measureAsync();
  return JSON.parse(json) as Passport;
}
