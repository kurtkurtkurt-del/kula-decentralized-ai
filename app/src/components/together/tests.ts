import { linkPassport } from '@/data/passport';
import { probeAll } from '@/llm/cluster';
import { chatLocal, chatRemote, type Device, type Reply } from '@/llm/engine';
import type { Message } from '@/llm/native';
import { isPeerQr, isRelayCode, isRemote, parseRelayCode, takePeerQr } from '@/llm/peers';
import { rememberPeer, type LocalModel, type Peer } from '@/llm/store';

// The tests on "see the power" (6.11.2026): what the together page can do for real once a
// phone is connected. No native code of its own: the qr goes through the same helpers as
// the peers page (llm/peers.ts), the ping is the gate probe (llm/cluster.ts probeAll), and
// the speed test is one short reply per device on the engine's apart copies (chatLocal /
// chatRemote), all at once, so the speeds add up the way apart mode adds them.

export type Taken = { kind: 'peer' | 'relay' | 'passport'; name: string };

/**
 * A scanned or pasted code, read the way the peers page reads it: a relay code, a peer qr
 * (v2/v3; its passport is linked too), or an old passport-only code. Throws the code's own
 * reason ('notPeer' | 'self' | 'old' | 'noRelay' | a passport parse error).
 */
export function takeCode(text: string): Taken {
  if (isRelayCode(text)) {
    const p = parseRelayCode(text);
    rememberPeer(p);
    return { kind: 'relay', name: p.name };
  }
  if (!isPeerQr(text)) {
    linkPassport(text);
    return { kind: 'passport', name: '' };
  }
  const p = takePeerQr(text);
  return { kind: 'peer', name: p.name.toLowerCase() };
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export type Ping = { id: string; ok: boolean; ms: number | null; why: string | null };

/**
 * Knocks on a peer's gate `rounds` times (a peer far away on its api channel through the
 * relay, a near one on rpc, as the peers page checks them); the middle time counts. The
 * first answer may spend the pairing code or teach the certificate: the next knock uses
 * what probeAll handed back.
 */
export async function pingPeer(peer: Peer, rounds = 3, now: () => number = Date.now): Promise<Ping> {
  const channel = isRemote(peer) ? 'api' : 'rpc';
  const times: number[] = [];
  let p = peer;
  for (let i = 0; i < rounds; i++) {
    const t0 = now();
    const r = await probeAll([p], channel);
    if (!r.ok.length) return { id: peer.id, ok: false, ms: null, why: r.bad[0]?.why ?? 'peer gone' };
    times.push(now() - t0);
    p = r.ok[0];
  }
  return { id: peer.id, ok: true, ms: median(times), why: null };
}

export const pingAll = (list: Peer[], rounds = 3): Promise<Ping[]> => Promise.all(list.map((p) => pingPeer(p, rounds)));

export const TRIAL_PROMPT = 'In one short sentence: what is a phone?';
export const TRIAL_TOKENS = 32;

export type SpeedRow = { id: string; name: string; local: boolean; tokens: number; tps: number; ms: number; error: string | null };
export type Speed = { rows: SpeedRow[]; total: number; alone: number | null; times: number | null; tokens: number; wallMs: number };

type Runner = {
  local: (m: Message[], onToken: (t: string) => void, o: { maxTokens: number; temperature: number; reset?: boolean }) => Promise<Reply>;
  remote: (d: Device, m: Message[], onToken: (t: string) => void, o: { maxTokens: number; temperature: number; reset?: boolean }) => Promise<Reply>;
};
const ENGINE: Runner = { local: chatLocal, remote: chatRemote };

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Every device of the loaded apart engine answers the same short prompt at the same time.
 * Per device its tok/s; together the sum (apart: each runs its own copy, the speeds add);
 * `times` is the sum over this phone's own speed. A measured speed is kept on the device,
 * as chat() does, so the dispatcher picks better afterwards. Throws 'nomodel' with no device.
 */
export async function speedTest(devices: Device[], opts: { maxTokens?: number; run?: Runner; now?: () => number } = {}): Promise<Speed> {
  if (!devices.length) throw new Error('nomodel');
  const run = opts.run ?? ENGINE;
  const now = opts.now ?? Date.now;
  const msgs: Message[] = [{ role: 'user', content: TRIAL_PROMPT }];
  const o = { maxTokens: opts.maxTokens ?? TRIAL_TOKENS, temperature: 0, reset: true };
  const t0 = now();
  const rows = await Promise.all(devices.map(async (d): Promise<SpeedRow> => {
    const base = { id: d.id, name: d.name, local: d.local };
    try {
      const r = await (d.local ? run.local(msgs, () => {}, o) : run.remote(d, msgs, () => {}, o));
      if (r.tps > 0) d.tps = r1(r.tps);
      return { ...base, tokens: r.tokens, tps: r1(r.tps), ms: r.ms, error: null };
    } catch (e) {
      return { ...base, tokens: 0, tps: 0, ms: 0, error: (e as Error).message || 'failed' };
    }
  }));
  const ok = rows.filter((r) => !r.error);
  const total = r1(ok.reduce((a, r) => a + r.tps, 0));
  const alone = ok.find((r) => r.local)?.tps ?? null;
  return { rows, total, alone, times: alone && ok.length > 1 ? r1(total / alone) : null, tokens: ok.reduce((a, r) => a + r.tokens, 0), wallMs: now() - t0 };
}

/** The model the trial loads: the one running, else the chosen one, else the first on the phone. */
export function trialModel(models: LocalModel[], running: LocalModel | null, chosen: string | null): LocalModel | null {
  const ready = models.filter((m) => !!m.path);
  return (running && ready.find((m) => m.id === running.id)) ?? ready.find((m) => m.id === chosen) ?? ready[0] ?? null;
}
