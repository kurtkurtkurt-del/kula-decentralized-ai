// lib/backend.ts: a downloaded build must reach a live server, never the Mac's local one.
import { describe, expect, it } from '@jest/globals';
import { backendProblem } from '@/lib/backend';

describe('backendProblem', () => {
  it('accepts a live https server in a release build', () => {
    expect(backendProblem('https://abcd.supabase.co', 'sb_publishable_x', false)).toBeNull();
  });
  it('refuses the Mac in a release build (what the 21.10.2026 apk was baked with)', () => {
    expect(backendProblem('http://10.203.94.191:4350', 'local', false)).toBe('devServer');
    expect(backendProblem('http://192.168.2.126:4350', 'local', false)).toBe('devServer');
    expect(backendProblem('http://localhost:4350', 'local', false)).toBe('devServer');
    expect(backendProblem('http://mac.local:4350', 'local', false)).toBe('devServer');
  });
  it('refuses plain http and a missing address', () => {
    expect(backendProblem('http://kula.example.org', 'k', false)).toBe('insecure');
    expect(backendProblem('', 'k', false)).toBe('missing');
    expect(backendProblem(undefined, undefined, false)).toBe('missing');
    expect(backendProblem('not a url', 'k', false)).toBe('missing');
  });
  it('lets development use the local server', () => {
    expect(backendProblem('http://10.0.80.200:4350', 'local', true)).toBeNull();
  });
});
