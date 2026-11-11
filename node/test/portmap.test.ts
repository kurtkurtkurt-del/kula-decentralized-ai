// Asking the router for the gate port (src/portmap.ts, docs/INTERNET.md): PCP, NAT-PMP and
// UPnP-IGD against fake routers on 127.0.0.1. Nothing here leaves this computer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import {
  startPortMapper, mapLine, parseProcRoute, parseRouteGet, parseRoutePrint, pcpAddr, pcpAddrText,
  pcpMapRequest, pmpMapRequest, igdControl,
} from '../src/portmap.ts';

type Mode = 'pcp' | 'pmp' | 'silent' | 'pcp-refuse';
interface Seen { v: number; op: number; lifetime: number; internal: number; external: number }

// One fake router on udp 127.0.0.1: PCP (version 2) and/or NAT-PMP (version 0), as `mode` says.
function fakeRouter(mode: Mode, o: { external?: string; grant?: number } = {}): Promise<{ port: number; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const ext = o.external ?? '203.0.113.7';
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('message', (b, from) => {
      const reply = (r: Buffer) => s.send(r, from.port, from.address);
      if (mode === 'silent') return;
      if (b[0] === 2 && b.length >= 60) {
        const lifetime = b.readUInt32BE(4), internal = b.readUInt16BE(40), external = b.readUInt16BE(42);
        seen.push({ v: 2, op: b[1], lifetime, internal, external });
        if (mode === 'pmp') { const r = Buffer.alloc(8); r[0] = 0; r[1] = 128 + b[1]; r.writeUInt16BE(1, 2); return reply(r); }
        const r = Buffer.alloc(60);
        r[0] = 2; r[1] = 0x81; r[3] = mode === 'pcp-refuse' ? 2 : 0;
        r.writeUInt32BE(lifetime === 0 ? 0 : Math.min(lifetime, o.grant ?? lifetime), 4);
        r.writeUInt32BE(1234, 8);
        b.copy(r, 24, 24, 44);                          // nonce, protocol, internal port
        r.writeUInt16BE(external || internal + 1000, 42);
        pcpAddr(ext).copy(r, 44);
        return reply(r);
      }
      if (b[0] === 0 && b[1] === 0 && mode === 'pmp') {
        const r = Buffer.alloc(12); r[1] = 128; r.writeUInt32BE(1234, 4);
        ext.split('.').forEach((x, i) => { r[8 + i] = Number(x); });
        return reply(r);
      }
      if (b[0] === 0 && b[1] === 2 && b.length >= 12 && mode === 'pmp') {
        const internal = b.readUInt16BE(4), external = b.readUInt16BE(6), lifetime = b.readUInt32BE(8);
        seen.push({ v: 0, op: 2, lifetime, internal, external });
        const r = Buffer.alloc(16); r[1] = 130; r.writeUInt32BE(1234, 4);
        r.writeUInt16BE(internal, 8); r.writeUInt16BE(lifetime === 0 ? 0 : external || internal, 10);
        r.writeUInt32BE(lifetime === 0 ? 0 : Math.min(lifetime, o.grant ?? lifetime), 12);
        return reply(r);
      }
    });
    s.bind(0, '127.0.0.1', () => resolve({ port: s.address().port, seen, close: () => s.close() }));
  });
}

const fast = { gateway: '127.0.0.1', timeoutMs: 30, tries: 2, ssdp: null } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('the wire forms: PCP addresses, a MAP request, a NAT-PMP request', () => {
  assert.equal(pcpAddr('192.168.1.20').toString('hex'), '00000000000000000000ffffc0a80114');
  assert.equal(pcpAddrText(pcpAddr('192.168.1.20')), '192.168.1.20');
  assert.equal(pcpAddrText(pcpAddr('2001:db8::1')), '2001:db8:0:0:0:0:0:1');
  const nonce = Buffer.alloc(12, 7);
  const m = pcpMapRequest('192.168.1.20', nonce, 50551, 50551, 3600);
  assert.equal(m.length, 60);
  assert.deepEqual([m[0], m[1], m.readUInt32BE(4), m[36], m.readUInt16BE(40), m.readUInt16BE(42)], [2, 1, 3600, 6, 50551, 50551]);
  assert.ok(m.subarray(24, 36).equals(nonce));
  assert.equal(pcpAddrText(m.subarray(44, 60)), '0.0.0.0', 'no wish for the external address');
  assert.equal(pmpMapRequest(50551, 50551, 7200).toString('hex'), '00020000c577c57700001c20');
});

test('the default gateway as each system says it', () => {
  assert.equal(parseProcRoute('Iface\tDestination\tGateway\tFlags\nwlan0\t00000000\t0101A8C0\t0003\nwlan0\t0001A8C0\t00000000\t0001\n'), '192.168.1.1');
  assert.equal(parseRouteGet('   route to: default\ndestination: default\n    gateway: 192.168.178.1\n  interface: en0\n'), '192.168.178.1');
  assert.equal(parseRoutePrint('Network Destination        Netmask          Gateway       Interface  Metric\n          0.0.0.0          0.0.0.0      10.0.0.138       10.0.0.20     25\n'), '10.0.0.138');
  assert.equal(parseRouteGet('route: writing to routing socket: not in table'), null);
});

test('PCP: the router maps the gate port, says the external address, and the mapping is removed on stop', async () => {
  const r = await fakeRouter('pcp');
  try {
    const { mapper, why } = await startPortMapper({ ...fast, internalPort: 50551, pmpPort: r.port });
    assert.equal(why, null);
    const m = mapper!.mapping()!;
    assert.deepEqual([m.via, m.gateway, m.internalPort, m.externalPort, m.externalIp, m.lifetimeS, m.behindAnotherNat], ['pcp', '127.0.0.1', 50551, 50551, '203.0.113.7', 3600, false]);
    assert.match(mapLine(m), /^port map: router 127\.0\.0\.1 \(pcp\) maps 203\.0\.113\.7:50551 to this computer's 50551, renews every 30 min$/);
    await mapper!.stop();
    assert.deepEqual(r.seen.map((x) => x.lifetime), [3600, 0], 'one map, one delete');
  } finally { r.close(); }
});

test('NAT-PMP: a router that answers PCP with version 0 is asked the old way', async () => {
  const r = await fakeRouter('pmp');
  try {
    const { mapper } = await startPortMapper({ ...fast, internalPort: 50552, pmpPort: r.port });
    const m = mapper!.mapping()!;
    assert.deepEqual([m.via, m.externalPort, m.externalIp], ['natpmp', 50552, '203.0.113.7']);
    await mapper!.stop();
    assert.deepEqual(r.seen.map((x) => [x.v, x.lifetime]), [[2, 3600], [0, 3600], [0, 0]]);
  } finally { r.close(); }
});

test('a short lease is renewed at half its life, on the same external port', async () => {
  const r = await fakeRouter('pcp', { grant: 1 });
  try {
    const { mapper } = await startPortMapper({ ...fast, internalPort: 50553, pmpPort: r.port, minRenewMs: 50 });
    assert.equal(mapper!.mapping()!.lifetimeS, 1);
    await sleep(1300);
    const renewals = r.seen.filter((x) => x.lifetime > 0);
    assert.ok(renewals.length >= 2, `renewed: ${renewals.length}`);
    assert.ok(renewals.slice(1).every((x) => x.external === 50553), 'asks for the port it already has');
    await mapper!.stop();
  } finally { r.close(); }
});

test('an external address that is itself private: the mapping does not reach the internet, and the qr leaves it out', async () => {
  const r = await fakeRouter('pcp', { external: '100.64.12.9' });
  try {
    const { mapper } = await startPortMapper({ ...fast, internalPort: 50554, pmpPort: r.port });
    const m = mapper!.mapping()!;
    assert.equal(m.behindAnotherNat, true);
    assert.match(mapLine(m), /behind another nat/);
    await mapper!.stop();
  } finally { r.close(); }
});

test('a router that refuses or stays silent: no mapping and the reason', async () => {
  const no = await fakeRouter('pcp-refuse');
  const quiet = await fakeRouter('silent');
  try {
    const a = await startPortMapper({ ...fast, internalPort: 50555, pmpPort: no.port });
    assert.equal(a.mapper, null);
    assert.equal(a.why, 'pcp: not authorized');
    const t0 = Date.now();
    const b = await startPortMapper({ ...fast, internalPort: 50555, pmpPort: quiet.port });
    assert.equal(b.mapper, null);
    assert.match(b.why!, /did not answer pcp, nat-pmp or upnp/);
    assert.ok(Date.now() - t0 < 2000, 'gives up in bounded time');
    assert.match(mapLine(null, b.why!), /^port map: none \(.*\); the gate is reached on this network only$/);
  } finally { no.close(); quiet.close(); }
});

// ---- UPnP-IGD: an ssdp answer (unicast to the test), a description, a soap control url

const DESC = (ctl: string) => `<?xml version="1.0"?><root><device><deviceList><device><serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/common</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${ctl}</controlURL></service>
</serviceList></device></deviceList></device></root>`;

async function fakeIgd(location: (httpPort: number) => string, o: { permanentOnly?: boolean } = {}) {
  const calls: { action: string; body: string }[] = [];
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.end(DESC('/ctl/IPConn')); return; }
      const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1] ?? '?';
      calls.push({ action, body });
      if (action === 'AddPortMapping' && o.permanentOnly && !/<NewLeaseDuration>0</.test(body)) {
        res.statusCode = 500;
        res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
        return;
      }
      if (action === 'GetExternalIPAddress') { res.end('<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>198.51.100.4</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>'); return; }
      res.end('<s:Envelope><s:Body/></s:Envelope>');
    });
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  const httpPort = (web.address() as net.AddressInfo).port;
  const ssdp = dgram.createSocket('udp4');
  let searches = 0;
  ssdp.on('message', (b, from) => {
    if (!b.toString().startsWith('M-SEARCH')) return;
    searches++;
    ssdp.send(Buffer.from(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: ${location(httpPort)}\r\n\r\n`), from.port, from.address);
  });
  await new Promise<void>((r) => ssdp.bind(0, '127.0.0.1', () => r()));
  return { calls, ssdp: { host: '127.0.0.1', port: ssdp.address().port }, searches: () => searches, close: () => { web.close(); ssdp.close(); } };
}

test('the control url of a WANIPConnection, relative to the description', () => {
  assert.deepEqual(igdControl(DESC('/ctl/IPConn'), 'http://192.168.1.1:5000/desc.xml'), { url: 'http://192.168.1.1:5000/ctl/IPConn', service: 'urn:schemas-upnp-org:service:WANIPConnection:1' });
  assert.equal(igdControl('<root><service><serviceType>urn:x</serviceType><controlURL>/a</controlURL></service></root>', 'http://192.168.1.1/'), null);
});

test('UPnP-IGD: when pcp and nat-pmp are silent, the router is found over ssdp and maps the port; a permanent-only router too', async () => {
  const quiet = await fakeRouter('silent');
  const igd = await fakeIgd((p) => `http://127.0.0.1:${p}/desc.xml`, { permanentOnly: true });
  try {
    const { mapper } = await startPortMapper({ ...fast, internalPort: 50556, pmpPort: quiet.port, ssdp: igd.ssdp, clientIp: '192.168.1.20' });
    const m = mapper!.mapping()!;
    assert.deepEqual([m.via, m.gateway, m.externalPort, m.externalIp, m.lifetimeS], ['upnp', '127.0.0.1', 50556, '198.51.100.4', 0]);
    const add = igd.calls.filter((c) => c.action === 'AddPortMapping');
    assert.equal(add.length, 2, 'a lease, then the permanent one after error 725');
    assert.match(add[1].body, /<NewInternalClient>192\.168\.1\.20<\/NewInternalClient>/);
    assert.match(add[1].body, /<NewProtocol>TCP<\/NewProtocol>/);
    assert.match(mapLine(m), /a lease without end, removed on stop/);
    await mapper!.stop();
    assert.equal(igd.calls.at(-1)!.action, 'DeletePortMapping');
  } finally { quiet.close(); igd.close(); }
});

test('UPnP-IGD: an ssdp answer pointing anywhere but the answering router is not followed', async () => {
  const quiet = await fakeRouter('silent');
  const igd = await fakeIgd(() => 'http://203.0.113.9:80/desc.xml');
  try {
    const { mapper, why } = await startPortMapper({ ...fast, internalPort: 50557, pmpPort: quiet.port, ssdp: igd.ssdp });
    assert.equal(mapper, null);
    assert.match(why!, /did not answer/);
    assert.ok(igd.searches() >= 1);
    assert.equal(igd.calls.length, 0);
  } finally { quiet.close(); igd.close(); }
});
