import { describe, expect, it, jest } from '@jest/globals';
import { models as translations } from '@/i18n/parts/models';

// The module has an iOS build now (modules/kula-llama/ios); the JS side must look for it on
// both phone platforms and the copy must not say "android" where it means "the phone app".
type Core = typeof import('expo-modules-core');
const loadWith = (os: string): { required: string[]; m: typeof import('@/llm/native') } => {
  const required: string[] = [];
  let m!: typeof import('@/llm/native');
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    jest.doMock('expo-modules-core', () => ({
      requireOptionalNativeModule: (n: string) => { required.push(n); return null; },
      // jest-expo's runtime reaches for this lazily; hand it the real one
      requireNativeModule: (n: string) => jest.requireActual<Core>('expo-modules-core').requireNativeModule(n),
    }));
    m = require('@/llm/native');
  });
  return { required, m };
};

describe('native module on ios', () => {
  it('asks for the module on android and ios, not on the web', () => {
    const ios = loadWith('ios');
    expect(ios.required).toEqual(['KulaLlama']);
    expect(ios.m.nativePossible()).toBe(true);
    expect(ios.m.NATIVE_PLATFORMS).toEqual(['android', 'ios']);
    expect(loadWith('android').required).toEqual(['KulaLlama']);
    const web = loadWith('web');
    expect(web.required).toEqual([]);
    expect(web.m.nativePossible()).toBe(false);
    expect(web.m.hasNative()).toBe(false);
  });

  it('no longer says the models are android-only', () => {
    const t = translations as Record<string, Record<string, string>>;
    for (const key of ['models.noNative', 'model.err.nonative']) {
      for (const lang of ['en', 'de', 'tr']) expect(t[key][lang]).not.toMatch(/only in the android|nur in der android|yalnızca android/);
    }
    for (const key of ['models.noNativeGo', 'share.iosForeground', 'share.throttledIos']) expect(t[key]).toBeDefined();
  });
});
