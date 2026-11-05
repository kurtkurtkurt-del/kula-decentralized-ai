// Property tests for the gate's hello line (fast-check). Whatever a stranger sends, the
// server answers one `NO <reason>` line and closes, never throws, and stays up for the
// next real client; a generated valid handshake always gets its OK and pipes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import * as fc from 'fast-check';
import { startGateServer, handshake, probe, LineReader, isNonce, type GateEvent, type GateServer } from '../src/gate.ts';

const SECRET = 'fuzz-secret';
const REASONS = new Set(['no hello', 'bad hello', 'bad channel', 'bad nonce', 'no proof', 'wrong secret', 'no tls', 'channel closed', 'target down']);

function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const s = net.createServer((c) => c.pipe(c));
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, close: () => s.close() }));
  });
}

// Sends `bytes`, collects everything the gate answers until it closes the connection.
function exchange(port: number, bytes: Buffer, timeoutMs = 3000): Promise<{ reply: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      resolve({ reply: Buffer.concat(chunks).toString('utf8'), closed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    s.on('connect', () => s.write(bytes));
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('error', () => finish(true));
    s.on('close', () => finish(true));
  });
}

const hex32 = fc.stringMatching(/^[0-9a-f]{32}$/);
const token = fc.oneof(
  fc.constantFrom('KULA1', 'KULA2', 'kula1', 'KULA', 'KULA10', 'rpc', 'api', 'RPC', 'xyz', '', '-', '1e3', '-1', '+5', 'NaN'),
  hex32,
  fc.stringMatching(/^[0-9a-f]{0,40}$/),
  fc.stringMatching(/^[0-9]{1,20}$/),
  fc.string({ maxLength: 12 }),
);
// a hello shaped like the real one, with each field free to be wrong or missing
const shaped = fc.array(token, { minLength: 0, maxLength: 6 }).map((fields) => fields.join(' '));
// text of any kind: unicode, control bytes, empty
const anyText = fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'binary', maxLength: 200 }), fc.constant(''));
const lineEnd = fc.constantFrom('\n', '\r\n', '\n\n', '\n' + 'x'.repeat(50) + '\n');
const helloLine = fc.tuple(fc.oneof(shaped, anyText), lineEnd).map(([line, end]) => Buffer.from(line + end, 'utf8'));
// raw bytes: utf-8 garbage, with a newline somewhere so the server does not wait out the handshake timer
const rawBytes = fc.uint8Array({ minLength: 0, maxLength: 400 }).map((a) => Buffer.concat([Buffer.from(a), Buffer.from('\n')]));
// no newline at all but longer than the reader's 4 KiB line limit
const tooLong = fc.integer({ min: 4097, max: 12000 }).chain((n) => fc.constantFrom('A', 'K', 'ÿ').map((c) => Buffer.alloc(n, c)));

let echo: { port: number; close: () => void };
let gate: GateServer;
const events: GateEvent[] = [];

test.before(async () => {
  echo = await echoServer();
  gate = await startGateServer({ port: 0, host: '127.0.0.1', secret: SECRET, targets: () => echo.port, onEvent: (e) => events.push(e) });
});
test.after(async () => { await gate.close(); echo.close(); });

const isValidHello = (text: string) => {
  const p = text.split('\n')[0].trim().split(' ');
  return (p.length === 3 || p.length === 4) && p[0] === 'KULA1' && (p[1] === 'rpc' || p[1] === 'api') && isNonce(p[2]) && (p.length === 3 || /^\d{1,16}$/.test(p[3]));
};

test('fuzz: any hello that is not a handshake gets one NO line and a closed socket', async () => {
  await fc.assert(fc.asyncProperty(fc.oneof(helloLine, rawBytes, tooLong), async (bytes) => {
    const text = bytes.toString('utf8');
    if (isValidHello(text)) return; // the nonce line comes back instead; covered below
    const { reply, closed } = await exchange(gate.port, bytes);
    assert.ok(closed, 'the gate must hang up');
    assert.match(reply, /^NO [a-z ]+\n$/, `reply was ${JSON.stringify(reply)} for ${JSON.stringify(text.slice(0, 80))}`);
    assert.ok(REASONS.has(reply.slice(3, -1)), reply);
  }), { numRuns: 300 });
});

test('fuzz: a valid hello followed by a wrong proof is refused, not crashed', async () => {
  await fc.assert(fc.asyncProperty(hex32, fc.constantFrom('rpc', 'api'), fc.option(fc.stringMatching(/^[0-9]{1,16}$/), { nil: undefined }), fc.oneof(fc.string({ maxLength: 100 }), fc.stringMatching(/^[0-9a-f]{64}$/)), async (nonce, ch, ts, proof) => {
    const hello = ts === undefined ? `KULA1 ${ch} ${nonce}\n` : `KULA1 ${ch} ${nonce} ${ts}\n`;
    const { reply, closed } = await exchange(gate.port, Buffer.from(hello + proof.replace(/\n/g, '') + '\n'));
    assert.ok(closed);
    const lines = reply.split('\n');
    assert.ok(isNonce(lines[0]), `expected the server nonce first, got ${JSON.stringify(reply)}`);
    assert.equal(lines[1], 'NO wrong secret');
  }), { numRuns: 100 });
});

test('fuzz: the first byte picks the protocol: 0x16 is tls (refused without a certificate), anything else is v1', async () => {
  await fc.assert(fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 120 }), fc.integer({ min: 0, max: 255 }), async (rest, first) => {
    const bytes = Buffer.concat([Buffer.from([first]), Buffer.from(rest), Buffer.from('\n')]);
    const { reply } = await exchange(gate.port, bytes);
    if (first === 0x16) assert.equal(reply, 'NO no tls\n');
    else assert.notEqual(reply.trim(), 'NO no tls');
  }), { numRuns: 150 });
});

test('fuzz: every generated handshake is accepted and the pipe carries any bytes', async () => {
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), fc.constantFrom('rpc', 'api'), fc.option(fc.integer({ min: 0, max: 9_999_999_999_999 }), { nil: undefined }), fc.uint8Array({ minLength: 1, maxLength: 2000 }), async (secret, ch, clock, payload) => {
    const e = await echoServer();
    const g = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: () => e.port });
    try {
      const s = net.connect({ port: g.port, host: '127.0.0.1' });
      await new Promise<void>((r) => s.once('connect', () => r()));
      const { socket, rest } = await handshake(s, secret, ch, 2000, clock);
      assert.equal(rest.length, 0);
      const got = await new Promise<Buffer>((resolve) => {
        const parts: Buffer[] = [];
        let n = 0;
        socket.on('data', (c: Buffer) => { parts.push(c); n += c.length; if (n >= payload.length) resolve(Buffer.concat(parts)); });
        socket.write(Buffer.from(payload));
      });
      assert.deepEqual(got, Buffer.from(payload));
      socket.destroy();
    } finally {
      await g.close();
      e.close();
    }
  }), { numRuns: 40 });
});

test('the gate still serves a real client after the garbage', async () => {
  const r = await probe('127.0.0.1', gate.port, SECRET, 'rpc');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(events.filter((e) => e.type === 'reject').length > 300);
});

test('LineReader never buffers more than the line limit while waiting', async () => {
  const s = new PassThrough();
  const r = new LineReader(s);
  const p = r.line(1000);
  s.write(Buffer.alloc(3000, 65));
  s.write(Buffer.alloc(3000, 66));
  await assert.rejects(p, /line too long/);
  assert.ok(r.release().length <= 6000);
});

test('fuzz: a line reader fed one byte at a time agrees with one fed everything at once', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string({ maxLength: 20 }).filter((l) => !l.includes('\n')), { minLength: 1, maxLength: 5 }), async (lines) => {
    const text = lines.map((l) => l + '\n').join('');
    const bytes = Buffer.from(text);
    const read = async (pieces: Buffer[]) => {
      const s = new PassThrough();
      const r = new LineReader(s);
      const out: string[] = [];
      const pump = (async () => { for (const p of pieces) { s.write(p); await new Promise((d) => setImmediate(d)); } })();
      for (let i = 0; i < lines.length; i++) out.push(await r.line(1000));
      await pump;
      return out;
    };
    const whole = await read([bytes]);
    const single = await read([...bytes].map((b) => Buffer.from([b])));
    assert.deepEqual(whole, lines);
    assert.deepEqual(single, lines);
  }), { numRuns: 60 });
});

test('nothing random here: the probe helper and random secrets agree with the server', async () => {
  const secret = randomBytes(16).toString('hex');
  const e = await echoServer();
  const g = await startGateServer({ port: 0, host: '127.0.0.1', secret, targets: () => e.port });
  try {
    assert.equal((await probe('127.0.0.1', g.port, secret, 'api')).ok, true);
  } finally { await g.close(); e.close(); }
});
