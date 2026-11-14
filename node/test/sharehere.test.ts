import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareHere } from '../src/ui/sharehere.ts';
import type { ShareHandle, ShareOptions } from '../src/share.ts';

function fakeStarter(seen: ShareOptions[], stops: { n: number }) {
  return async (opts: ShareOptions): Promise<ShareHandle> => {
    seen.push(opts);
    let pin = '123456';
    return Object.assign(async () => { stops.n++; }, {
      gatePort: opts.port, dashboard: null, deviceName: 'test-pc', host: '192.168.1.5',
      qr: () => JSON.stringify({ k: 'kula-peer', v: 3, pin }),
      code: () => ({ pin, exp: 1_000 }),
    });
  };
}

test('ShareHere starts the worker once, shows its code and qr, and stops it', async () => {
  const seen: ShareOptions[] = [];
  const stops = { n: 0 };
  const s = new ShareHere({ port: 50999, models: '/tmp/m', start: fakeStarter(seen, stops) });
  assert.deepEqual({ on: s.view().on, qr: s.qr() }, { on: false, qr: null });
  const [a, b] = await Promise.all([s.start(), s.start()]);
  assert.equal(seen.length, 1, 'two clicks start one worker');
  assert.equal(seen[0].port, 50999);
  assert.equal(seen[0].noQr, true);
  assert.equal(seen[0].dashboard, false);
  for (const v of [a, b]) {
    assert.equal(v.on, true);
    assert.equal(v.starting, false);
    assert.equal(v.code, '123456');
    assert.equal(v.host, '192.168.1.5');
    assert.equal(v.port, 50999);
  }
  assert.match(s.qr()!, /"pin":"123456"/);
  const off = await s.stop();
  assert.equal(off.on, false);
  assert.equal(off.code, null);
  assert.equal(stops.n, 1);
  await s.stop();
  assert.equal(stops.n, 1, 'stopping twice stops once');
});

test('ShareHere: a taken port says so in plain words and can be tried again', async () => {
  let fail = true;
  const seen: ShareOptions[] = [];
  const stops = { n: 0 };
  const ok = fakeStarter(seen, stops);
  const s = new ShareHere({
    port: 50999,
    start: async (o) => { if (fail) throw new Error('listen EADDRINUSE: address already in use :::50999'); return ok(o); },
  });
  const v = await s.start();
  assert.equal(v.on, false);
  assert.match(v.error!, /share port is taken/);
  fail = false;
  const w = await s.start();
  assert.equal(w.on, true);
  assert.equal(w.error, null);
  await s.stop();
});
