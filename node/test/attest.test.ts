// owner-blind (attest.ts): Android key attestation checked on this computer.
//
// Real chains: node/test/fixtures/attestation/*.pem are copied unchanged from Google's
// attestation verification library, https://github.com/android/keyattestation (testdata/,
// Apache-2.0, fetched 11.11.2026): tegu sdk36 (a preproduction Pixel 9a, the 2026 ECDSA root, TEE
// and StrongBox), caiman sdk36 (a Pixel 9 Pro, RKP under the RSA root), walleye sdk27 (a Pixel 2,
// factory keys under the 2016 RSA root, unlocked) and marlin sdk29 (the software attestation root).
// The expected values below are from the .json files next to them there. Their challenges are the
// test app's own, so a real chain stops at the challenge here; what comes after it (the hardware's
// claims against kula's rules) is checked with chains made below, under a test root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import {
  ownerBlind, parseKeyDescription, extension, googleRoots, keyChallenge, bindMessage, parseStatusList, loadStatusList,
  refreshStatusList, serialForms, loadAttestConfig, DEBUG_SIGNER, KULA_PACKAGE, STATUS_URL, type AttestInput, type Root,
} from '../src/attest.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'attestation');
const pems = (name: string) => fs.readFileSync(path.join(FIX, `${name}.pem`), 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
const chainOf = (name: string) => pems(name).map((p) => new X509Certificate(p).raw.toString('base64'));
const at = (iso: string) => new Date(iso).getTime();
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();
const TEST_APP_SIGNER = Buffer.from('EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE=', 'base64').toString('hex');
const CH = 'ab'.repeat(32);

function device() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return { privateKey, pub: pub.toString('base64'), id: sha(pub).toString('hex').slice(0, 32), alg: 'p256' };
}
const dev = device();
const input = (chain: string[], sig = 'AA==', d = dev, challenge = CH): AttestInput => ({ attest: { v: 1, chain, sig }, challenge, id: d.id, alg: d.alg, pub: d.pub });

// ---- real chains ------------------------------------------------------------------------------

test('the pinned roots are Google’s two, matched by public key: the 2019 RSA root reissue counts as the 2022 one', () => {
  const roots = googleRoots();
  assert.deepEqual(roots.map((r) => r.name), ['google-rsa', 'google-ec']);
  const top = new X509Certificate(pems('caiman_sdk36_TEE_EC_RKP').at(-1)!);
  assert.equal(top.serialNumber, 'D50FF25BA3F2D6B3', 'the 2019 issue, not the pinned bytes');
  assert.ok(roots[0].spki.equals(top.publicKey.export({ type: 'spki', format: 'der' }) as Buffer));
});

test('a real key description is read as Google’s library reads it (tegu, Pixel 9a, TEE, 2026 root)', () => {
  const leaf = new X509Certificate(pems('tegu_sdk36_TEE_EC_2026_ROOT')[0]).raw;
  const kd = parseKeyDescription(extension(leaf)!);
  assert.equal(kd.attestationVersion, 400);
  assert.equal(kd.attestationSecurityLevel, 1);
  assert.equal(kd.keyMintSecurityLevel, 1);
  assert.equal(kd.challenge.toString(), '6417f92c-daef-4cc1-8828-5bb39338ffd5');
  assert.equal(kd.rootOfTrust!.locked, true);
  assert.equal(kd.rootOfTrust!.boot, 0);
  assert.equal(kd.rootOfTrust!.bootKey.toString('base64'), 'MyevYthKuJevJSOhbctYAeYMXVuX9ByhvQmcR4T3t0M=');
  assert.equal(kd.rootOfTrust!.bootHash!.toString('base64'), '7Owyr9T0ZfyInz7SDm95qsof0as6351/GX7KuwyaOFY=');
  assert.deepEqual(kd.app, { packages: [{ name: 'com.google.android.attestation', version: 0 }], digests: [TEST_APP_SIGNER] });
  assert.equal(kd.osVersion, 160000);
  assert.equal(kd.osPatchLevel, 202602);
  // StrongBox, and an unlocked factory phone
  const sb = parseKeyDescription(extension(new X509Certificate(pems('tegu_sdk36_SB_EC_2026_ROOT')[0]).raw)!);
  assert.equal(sb.attestationSecurityLevel, 2);
  assert.equal(sb.attestationVersion, 300);
  const old = parseKeyDescription(extension(new X509Certificate(pems('walleye_sdk27_TEE_EC_NONE')[0]).raw)!);
  assert.equal(old.attestationVersion, 2);
  assert.equal(old.rootOfTrust!.locked, false);
  assert.equal(old.rootOfTrust!.boot, 2);
  assert.equal(old.rootOfTrust!.bootHash, null, 'version 2 has no boot hash');
  assert.equal(old.osPatchLevel, 201807);
  // only the leaf carries it
  for (const p of pems('tegu_sdk36_TEE_EC_2026_ROOT').slice(1)) assert.equal(extension(new X509Certificate(p).raw), null);
});

test('real chains verify to Google’s roots, and then stop at the challenge: it was not this computer’s question', () => {
  const tegu = ownerBlind(input(chainOf('tegu_sdk36_TEE_EC_2026_ROOT')), { now: at('2026-02-25') });
  assert.equal(tegu.why, 'challenge');
  assert.equal(tegu.ok, false);
  assert.equal(tegu.facts.root, 'google-ec');
  assert.equal(tegu.facts.level, 'tee');
  assert.equal(tegu.facts.boot, 'green');
  assert.equal(tegu.facts.locked, true);
  assert.equal(tegu.facts.patch, '2026-02');
  assert.equal(tegu.facts.app, 'com.google.android.attestation');
  assert.equal(ownerBlind(input(chainOf('tegu_sdk36_SB_EC_2026_ROOT')), { now: at('2026-02-25') }).facts.level, 'strongbox');
  const caiman = ownerBlind(input(chainOf('caiman_sdk36_TEE_EC_RKP')), { now: at('2025-09-27') });
  assert.equal(caiman.why, 'challenge');
  assert.equal(caiman.facts.root, 'google-rsa');
});

test('an expired chain: RKP certificates are short-lived on purpose; factory ones are trusted past their date', () => {
  const caiman = ownerBlind(input(chainOf('caiman_sdk36_TEE_EC_RKP')), { now: at('2026-11-11') });
  assert.equal(caiman.why, 'expired');
  assert.match(caiman.text, /expired on 2025-10-03/);
  assert.equal(ownerBlind(input(chainOf('caiman_sdk36_TEE_EC_RKP')), { now: at('2024-01-01') }).why, 'expired', 'not valid yet');
  // walleye's factory chain ended in May 2026, its root with it: still read, then its challenge is not ours
  const walleye = ownerBlind(input(chainOf('walleye_sdk27_TEE_EC_NONE')), { now: at('2026-11-11') });
  assert.equal(walleye.why, 'challenge');
  assert.equal(walleye.facts.locked, false);
});

test('the software attestation root is not Google’s: nothing shows the key is in hardware', () => {
  const r = ownerBlind(input(chainOf('marlin_sdk29_TEE_EC_NONE')), { now: at('2020-01-01') });
  assert.equal(r.why, 'root');
  assert.equal(r.ok, false);
});

test('a broken or reordered chain does not hold together', () => {
  const c = chainOf('tegu_sdk36_TEE_EC_2026_ROOT');
  assert.equal(ownerBlind(input([c[0], c[2], c[3], c[4]]), { now: at('2026-02-25') }).why, 'chain');
  assert.equal(ownerBlind(input([c[0], ...chainOf('caiman_sdk36_TEE_EC_RKP').slice(1)]), { now: at('2025-09-27') }).why, 'chain');
  assert.equal(ownerBlind(input(c.slice(0, 4)), { now: at('2026-02-25') }).why, 'root', 'the root left out');
});

test('a revoked key in the chain, when the person keeps Google’s list; its keys read in hex and in decimal', () => {
  const c = chainOf('caiman_sdk36_TEE_EC_RKP');
  const ca3 = new X509Certificate(Buffer.from(c[2], 'base64')).serialNumber;
  assert.deepEqual(serialForms('0388266760658996860D'), ['388266760658996860d', BigInt('0x0388266760658996860D').toString(10)]);
  const hex = parseStatusList({ entries: { [serialForms(ca3)[0]]: { status: 'REVOKED', reason: 'KEY_COMPROMISE' } } }, at('2025-09-20'))!;
  const r = ownerBlind(input(c), { now: at('2025-09-27'), status: hex });
  assert.equal(r.why, 'revoked');
  const dec = parseStatusList({ entries: { [serialForms(ca3)[1]]: { status: 'SUSPENDED' } } }, 0)!;
  assert.equal(ownerBlind(input(c), { now: at('2025-09-27'), status: dec }).why, 'revoked');
  const other = parseStatusList({ entries: { abc: { status: 'REVOKED' } } }, at('2025-09-20'))!;
  const ok = ownerBlind(input(c), { now: at('2025-09-27'), status: other });
  assert.equal(ok.why, 'challenge');
  assert.equal(ok.facts.revocation, 'checked against Google’s list of 2025-09-20');
  assert.equal(parseStatusList({ nope: 1 }, 0), null);
});

test('the status list is a file the person refreshes: none by default, read when there, fetched only when asked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-attest-'));
  const f = path.join(dir, 'attestation-status.json');
  assert.equal(loadStatusList(f), null);
  let asked = '';
  const get = (async (url: string) => { asked = url; return new Response(JSON.stringify({ entries: { 'c35747a084470c3135aeefe2b8d40cd6': { status: 'REVOKED' }, '6681152659205225093': { status: 'REVOKED' } } })); }) as unknown as typeof fetch;
  const l = await refreshStatusList(f, get);
  assert.equal(asked, STATUS_URL);
  assert.equal(l.serials.size, 2);
  assert.equal(loadStatusList(f)!.serials.has('6681152659205225093'), true);
  const bad = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(refreshStatusList(f, bad), /503/);
  assert.equal(loadStatusList(f)!.serials.size, 2, 'a failed refresh keeps the list there was');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('signers: none official yet; the person may name theirs in attestation.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-attest-'));
  const f = path.join(dir, 'attestation.json');
  assert.deepEqual(loadAttestConfig(f), { signers: [], pkg: KULA_PACKAGE });
  fs.writeFileSync(f, JSON.stringify({ signers: ['FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C', 'nonsense'] }));
  assert.deepEqual(loadAttestConfig(f).signers, [DEBUG_SIGNER]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('what a device sent instead of a proof', () => {
  const base = { challenge: CH, id: dev.id, alg: dev.alg, pub: dev.pub };
  assert.deepEqual([ownerBlind({ ...base, attest: undefined }, { now: 0 }).ok, ownerBlind({ ...base, attest: undefined }, { now: 0 }).why], [null, 'old']);
  assert.deepEqual([ownerBlind({ ...base, attest: null }, { now: 0 }).ok, ownerBlind({ ...base, attest: null }, { now: 0 }).text], [null, 'a computer cannot prove this']);
  const no = ownerBlind({ ...base, attest: { v: 1, error: 'no keystore on this device' } }, { now: 0 });
  assert.equal(no.ok, false);
  assert.equal(no.why, 'cannot');
  for (const a of [{}, { v: 2 }, { v: 1, chain: 'x', sig: 'y' }, { v: 1, chain: ['AA=='], sig: 'y' }, [1], 'x']) {
    assert.equal(ownerBlind({ ...base, attest: a }, { now: 0 }).why, 'malformed', JSON.stringify(a));
  }
  assert.equal(ownerBlind({ ...base, attest: { v: 1, chain: ['AAAA', 'AAAA'], sig: 'y' } }, { now: 0 }).why, 'malformed');
});

// ---- made chains: kula's rules over what the hardware says ------------------------------------

// a little DER writer, enough for a certificate
const len = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...x: Buffer[]) => tlv(0x30, Buffer.concat(x));
const set = (...x: Buffer[]) => tlv(0x31, Buffer.concat(x));
const octet = (b: Buffer | string) => tlv(0x04, Buffer.from(b));
const int = (n: number) => { const h = n.toString(16); const b = Buffer.from(h.length % 2 ? `0${h}` : h, 'hex'); return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b); };
const enm = (n: number) => tlv(0x0a, Buffer.from([n]));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const oid = (s: string) => { const p = s.split('.').map(Number); const out = [40 * p[0] + p[1]]; for (const n of p.slice(2)) { const t = [n & 127]; for (let v = n >> 7; v; v >>= 7) t.unshift((v & 127) | 128); out.push(...t); } return tlv(0x06, Buffer.from(out)); };
/** [n] EXPLICIT, n may be past 30 (the high tag form) */
const ctx = (n: number, inner: Buffer) => {
  if (n < 31) return Buffer.concat([Buffer.from([0xa0 | n]), len(inner.length), inner]);
  const t = [n & 127]; for (let v = n >> 7; v; v >>= 7) t.unshift((v & 127) | 128);
  return Buffer.concat([Buffer.from([0xbf, ...t]), len(inner.length), inner]);
};
const utc = (ms: number) => tlv(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function cert(o: { serial: number; issuer: string; subject: string; pub: KeyObject; signer: KeyObject; from: number; to: number; kd?: Buffer }): Buffer {
  const exts = o.kd ? ctx(3, seq(seq(oid('1.3.6.1.4.1.11129.2.1.17'), octet(o.kd)))) : Buffer.alloc(0);
  const tbs = seq(ctx(0, int(2)), int(o.serial), ECDSA_SHA256, name(o.issuer), seq(utc(o.from), utc(o.to)), name(o.subject), o.pub.export({ type: 'spki', format: 'der' }) as Buffer, exts);
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, o.signer)])));
}

interface Claims { level?: number; locked?: boolean; boot?: number; pkg?: string[]; digests?: string[]; challenge?: Buffer; noRot?: boolean; patch?: number }
function keyDescription(c: Claims): Buffer {
  const app = octet(seq(set(...(c.pkg ?? [KULA_PACKAGE]).map((p) => seq(octet(p), int(1)))), set(...(c.digests ?? [DEBUG_SIGNER]).map((d) => octet(Buffer.from(d, 'hex'))))));
  const rot = seq(octet(Buffer.alloc(32, 7)), bool(c.locked ?? true), enm(c.boot ?? 0), octet(Buffer.alloc(32, 9)));
  const level = c.level ?? 1;
  return seq(int(300), enm(level), int(300), enm(level), octet(c.challenge ?? keyChallenge(CH, dev.id)), octet(Buffer.alloc(0)),
    seq(ctx(709, app)),
    seq(...(c.noRot ? [] : [ctx(704, rot)]), ctx(706, int(c.patch ?? 202510))));
}

const NOW = at('2026-11-11T12:00:00Z');
const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const root = ec(), mid = ec();
const testRoots: Root[] = [{ name: 'test', spki: root.publicKey.export({ type: 'spki', format: 'der' }) as Buffer }];
const ROOT = cert({ serial: 1, issuer: 'test root', subject: 'test root', pub: root.publicKey, signer: root.privateKey, from: NOW - 1e10, to: NOW + 1e10 });
const MID = cert({ serial: 77, issuer: 'test root', subject: 'test tee', pub: mid.publicKey, signer: root.privateKey, from: NOW - 1e9, to: NOW + 1e9 });

/** a chain under the test root with these claims, signed into this device the way Attest.kt does */
function made(c: Claims = {}, o: { d?: typeof dev; midKd?: boolean } = {}): AttestInput {
  const d = o.d ?? dev;
  const leafKey = ec();
  const leaf = cert({ serial: 1, issuer: 'test tee', subject: 'Android Keystore Key', pub: leafKey.publicKey, signer: mid.privateKey, from: 0, to: NOW + 1e10, kd: keyDescription(c) });
  const midCert = o.midKd ? cert({ serial: 77, issuer: 'test root', subject: 'test tee', pub: mid.publicKey, signer: root.privateKey, from: NOW - 1e9, to: NOW + 1e9, kd: keyDescription(c) }) : MID;
  const sig = sign(d.alg === 'ed25519' ? null : 'sha256', bindMessage(CH, leaf), d.privateKey).toString('base64');
  return { attest: { v: 1, chain: [leaf, midCert, ROOT].map((b) => b.toString('base64')), sig }, challenge: CH, id: d.id, alg: d.alg, pub: d.pub };
}
const check = (i: AttestInput, signers: string[] = []) => ownerBlind(i, { now: NOW, roots: testRoots, signers });

test('hardware key, locked, green, kula, but the public debug key: its owner could still read jobs', () => {
  const r = check(made());
  assert.equal(r.ok, false);
  assert.equal(r.why, 'unofficial');
  assert.equal(r.text, 'hardware key, locked, verified boot, but a debug build (signed with the public debug key): its owner could still read jobs');
  assert.equal(r.facts.signer, DEBUG_SIGNER);
  const other = check(made({ digests: ['11'.repeat(32)] }));
  assert.equal(other.text, 'hardware key, locked, verified boot, but not an official kula build: its owner could still read jobs');
});

test('an official signer: its owner cannot read jobs (said with what was not checked)', () => {
  const r = check(made({ digests: ['11'.repeat(32)], level: 2 }), ['11'.repeat(32)]);
  assert.equal(r.ok, true);
  assert.equal(r.why, 'ok');
  assert.equal(r.text, 'StrongBox key, locked, verified boot, official kula build: its owner cannot read jobs (security patch 2025-10; revocation not checked)');
  const withList = ownerBlind(made({ digests: ['11'.repeat(32)] }), { now: NOW, roots: testRoots, signers: ['11'.repeat(32)], status: parseStatusList({ entries: {} }, NOW)! });
  assert.equal(withList.text, 'hardware key, locked, verified boot, official kula build: its owner cannot read jobs (security patch 2025-10)');
});

test('each thing the hardware says can fail it', () => {
  const s = ['11'.repeat(32)];
  const official = { digests: s };
  assert.equal(check(made({ ...official, level: 0 }), s).why, 'software');
  assert.equal(check(made({ ...official, locked: false }), s).why, 'unlocked');
  assert.equal(check(made({ ...official, noRot: true }), s).why, 'unlocked', 'no root of trust is no lock');
  const yellow = check(made({ ...official, boot: 1 }), s);
  assert.equal(yellow.why, 'boot');
  assert.match(yellow.text, /verified boot is yellow/);
  assert.equal(check(made({ ...official, boot: 2 }), s).why, 'boot');
  assert.equal(check(made({ ...official, pkg: ['com.evil'] }), s).why, 'app');
  assert.equal(check(made({ ...official, pkg: [KULA_PACKAGE, 'com.shared.uid'] }), s).why, 'app', 'a uid shared with another app');
});

test('the proof is this computer’s question, for this device, signed by its ledger key', () => {
  // another question
  assert.equal(check(made({ challenge: keyChallenge('cd'.repeat(32), dev.id) })).why, 'challenge');
  assert.equal(check({ ...made(), challenge: 'cd'.repeat(32) }).why, 'challenge');
  // a proof made for another device (its kula put its own id in), passed off by this one
  const other = device();
  assert.equal(check(made({ challenge: keyChallenge(CH, other.id) })).why, 'challenge');
  // signed by another key than the one that signs its ledger
  const i = made();
  const forged = made({}, { d: other });
  assert.equal(check({ ...i, attest: { ...(i.attest as object), sig: (forged.attest as { sig: string }).sig } }).why, 'bound');
  // a device id that is not its key's
  assert.equal(check({ ...made({ challenge: keyChallenge(CH, other.id) }), id: other.id }).why, 'bound');
  // ed25519 device keys sign too
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const ed = { privateKey, pub: pub.toString('base64'), id: sha(pub).toString('hex').slice(0, 32), alg: 'ed25519' };
  assert.equal(check(made({ challenge: keyChallenge(CH, ed.id) }, { d: ed })).why, 'unofficial');
});

test('a key description anywhere but the leaf: the hardware never puts one there', () => {
  assert.equal(check(made({}, { midKd: true })).why, 'chain');
});
