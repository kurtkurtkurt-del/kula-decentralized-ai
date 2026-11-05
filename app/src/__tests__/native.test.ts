// The thin wrapper around the native module (5.11.2026), as it is under jest (no module,
// like Expo Go): it says 'nonative' and falls back to the default gate port. The android
// path with the module present is covered by the tests that mock '@/llm/native' wholesale.
import { describe, expect, it } from '@jest/globals';
import { GATE_PORT, hasNative, llama, native } from '@/llm/native';

describe('native()', () => {
  it('is absent here: nonative, no module, the default gate port', () => {
    expect(llama).toBeNull();
    expect(hasNative()).toBe(false);
    expect(() => native()).toThrow('nonative');
    expect(GATE_PORT).toBe(50551);
  });
});
