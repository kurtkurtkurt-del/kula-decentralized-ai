#!/usr/bin/env node
// `kula-relay`: the server from server.ts with its knobs from the environment.
import { startRelay } from './server.js';

const num = (k: string, d: number) => { const v = process.env[k]; const n = v ? Number(v) : NaN; return Number.isFinite(n) ? n : d; };
const stamp = () => new Date().toISOString().slice(11, 19);

const relay = await startRelay({
  port: num('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  codeTtlMs: num('RELAY_CODE_TTL_S', 600) * 1000,
  maxWorkers: num('RELAY_MAX_WORKERS', 1000),
  maxStreamsPerSession: num('RELAY_MAX_STREAMS', 16),
  maxBytesPerSession: num('RELAY_MAX_MB', 1024) * 1024 * 1024,
  connectsPerMinute: num('RELAY_CONNECTS_PER_MIN', 120),
  badCodesPerMinute: num('RELAY_BAD_CODES_PER_MIN', 10),
  log: (s) => console.log(`${stamp()}  ${s}`),
});
const stop = () => relay.close().finally(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
