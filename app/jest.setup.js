// Shared by every test: expo-sqlite's localStorage polyfill opens a native database, which
// jest does not have. supabase.ts and secureStorage.ts import it for its side effect, so any
// test that reaches them through an import chain would fail to start. Give them an in-memory
// localStorage instead.
jest.mock('expo-sqlite/localStorage/install', () => {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  return {};
});
