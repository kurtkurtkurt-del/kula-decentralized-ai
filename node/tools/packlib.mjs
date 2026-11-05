// Shared by tools/pack.mjs and tools/release-files.mjs: the targets, the
// pinned Node release the single binaries are built from, and the release
// files (debian package, homebrew formula, winget manifests) made from them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = 'kurtkurtkurt-del/kula-decentralized-ai';
export const HOMEPAGE = `https://github.com/${REPO}`;
export const DESCRIPTION = 'make this computer a worker in a kula phone cluster';

// The Node release inside every binary. SHASUMS256.txt is checked against the
// pinned hash below before any line of it is trusted; each Node archive is
// then checked against its line. A new version needs its SHASUMS256.txt hash
// here (curl -fsSL https://nodejs.org/dist/vX/SHASUMS256.txt | shasum -a 256).
export const NODE_VERSION = '24.22.2';
export const NODE_SHASUMS_SHA256 = {
  '24.22.2': 'aec92ae945293821c22aed4c37b97741688254bac353b861fc9fb25b81ce4567',
};

// target -> where its node binary comes from
export const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', dist: 'darwin-arm64', ext: '' },
  'mac-x64': { platform: 'darwin', arch: 'x64', dist: 'darwin-x64', ext: '' },
  'linux-x64': { platform: 'linux', arch: 'x64', dist: 'linux-x64', ext: '' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', dist: 'linux-arm64', ext: '' },
  'win-x64': { platform: 'win32', arch: 'x64', dist: 'win-x64', ext: '.exe' },
};

export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function hostTarget(platform = process.platform, arch = process.arch) {
  const t = Object.entries(TARGETS).find(([, v]) => v.platform === platform && v.arch === arch);
  return t ? t[0] : null;
}

export function binaryName(target) {
  return `kula-node-${target}${TARGETS[target].ext}`;
}

// The file in the Node release that holds the node binary for a target, and
// the path of the binary inside it (null: the file is the binary).
export function nodeAsset(target, version = NODE_VERSION) {
  const t = TARGETS[target];
  if (t.platform === 'win32') return { file: `${t.dist}/node.exe`, inner: null };
  return { file: `node-v${version}-${t.dist}.tar.gz`, inner: `node-v${version}-${t.dist}/bin/node` };
}

export function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(NODE_DIR, 'package.json'), 'utf8')).version;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// "<hex>  <name>" lines (sha256sum's format, also with a "*" binary marker).
export function parseSums(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

export function formatSums(entries) {
  return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, hex]) => `${hex}  ${name}`).join('\n') + '\n';
}

export function releaseUrl(version, file) {
  return `${HOMEPAGE}/releases/download/v${version}/${file}`;
}

const placeholder = (file) => `REPLACE_WITH_SHA256_OF_${file}`;

// The homebrew formula. `sums` maps release file names to sha256; a missing
// one is left as a placeholder (the checked-in draft is rendered that way).
export function renderFormula(version, sums = new Map()) {
  const one = (target, indent) => {
    const f = binaryName(target);
    return `${indent}url "${releaseUrl(version, f)}"\n${indent}sha256 "${sums.get(f) ?? placeholder(f)}"`;
  };
  return `# kula-node homebrew formula (draft). Rendered by node/tools/release-files.mjs
# from node/package.json and the release's sha256sums.txt; the release job
# attaches the filled-in copy. For a tap: put it in Formula/kula-node.rb of
# a homebrew-kula repository, then: brew install ${REPO.split('/')[0]}/kula/kula-node
class KulaNode < Formula
  desc "${DESCRIPTION[0].toUpperCase()}${DESCRIPTION.slice(1)}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${one('mac-arm64', '      ')}
    end
    on_intel do
${one('mac-x64', '      ')}
    end
  end

  on_linux do
    on_arm do
${one('linux-arm64', '      ')}
    end
    on_intel do
${one('linux-x64', '      ')}
    end
  end

  def install
    bin.install Dir["kula-node-*"].first => "kula-node"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kula-node --version")
  end
end
`;
}

export const WINGET_ID = 'Kula.KulaNode';

// The three winget manifest files (version, installer, default locale).
export function renderWinget(version, sums = new Map()) {
  const f = binaryName('win-x64');
  const head = (type) => `# winget manifest (draft), rendered by node/tools/release-files.mjs
# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.6.0.schema.json
`;
  return {
    [`${WINGET_ID}.yaml`]: `${head('version')}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`,
    [`${WINGET_ID}.installer.yaml`]: `${head('installer')}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
InstallerType: portable
Commands:
  - kula-node
Installers:
  - Architecture: x64
    InstallerUrl: ${releaseUrl(version, f)}
    InstallerSha256: ${sums.get(f)?.toUpperCase() ?? placeholder(f)}
ManifestType: installer
ManifestVersion: 1.6.0
`,
    [`${WINGET_ID}.locale.en-US.yaml`]: `${head('defaultLocale')}
PackageIdentifier: ${WINGET_ID}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: kula
PackageName: kula-node
License: MIT
ShortDescription: ${DESCRIPTION}
Description: |-
  kula-node turns this computer into a worker for a kula phone cluster: it gets
  llama.cpp, opens a gate the phone pairs with by qr code, and can run a cluster
  of phones and computers from here. After installing: kula-node setup, then kula-node share.
  Windows defender firewall asks about kula-node on the first share: allow private networks only.
PackageUrl: ${HOMEPAGE}
Moniker: kula-node
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`,
  };
}

// ---- a .deb, written here so it builds anywhere (no dpkg-deb needed) ----

// One ustar entry: 512-byte header, then the data padded to 512.
function tarEntry(name, { mode, type = '0', data = Buffer.alloc(0), mtime }) {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8); // uid root
  put(oct(0, 8), 116, 8); // gid root
  put(oct(type === '5' ? 0 : data.length, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('root', 265, 32);
  put('root', 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

export function tarGz(entries, mtime) {
  const parts = entries.map((e) => tarEntry(e.name, { ...e, mtime }));
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

function arMember(name, data, mtime) {
  const h = `${name.padEnd(16)}${String(mtime).padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
  if (h.length !== 60) throw new Error('ar header');
  return Buffer.concat([Buffer.from(h, 'latin1'), data, data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
}

export const DEB_ARCH = { 'linux-x64': 'amd64', 'linux-arm64': 'arm64' };

// A debian package holding /usr/bin/kula-node.
export function makeDeb({ version, target, binary, mtime = Math.floor(Date.now() / 1000) }) {
  const arch = DEB_ARCH[target];
  if (!arch) throw new Error(`no debian architecture for ${target}`);
  const md5 = createHash('md5').update(binary).digest('hex');
  const control = [
    'Package: kula-node',
    `Version: ${version}`,
    `Architecture: ${arch}`,
    'Maintainer: kula <noreply@users.noreply.github.com>',
    `Installed-Size: ${Math.ceil(binary.length / 1024)}`,
    'Section: net',
    'Priority: optional',
    `Homepage: ${HOMEPAGE}`,
    `Description: ${DESCRIPTION}`,
    ' A single executable (node and kula-node in one file). After installing:',
    ' kula-node setup, then kula-node share.',
    '',
  ].join('\n');
  const controlTar = tarGz([
    { name: './', mode: 0o755, type: '5' },
    { name: './control', mode: 0o644, data: Buffer.from(control) },
    { name: './md5sums', mode: 0o644, data: Buffer.from(`${md5}  usr/bin/kula-node\n`) },
  ], mtime);
  const dataTar = tarGz([
    { name: './', mode: 0o755, type: '5' },
    { name: './usr/', mode: 0o755, type: '5' },
    { name: './usr/bin/', mode: 0o755, type: '5' },
    { name: './usr/bin/kula-node', mode: 0o755, data: binary },
  ], mtime);
  return {
    name: `kula-node_${version}_${arch}.deb`,
    data: Buffer.concat([
      Buffer.from('!<arch>\n'),
      arMember('debian-binary', Buffer.from('2.0\n'), mtime),
      arMember('control.tar.gz', controlTar, mtime),
      arMember('data.tar.gz', dataTar, mtime),
    ]),
  };
}

// Reads an ar archive back (tests, and a sanity check after writing).
export function readAr(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new Error('not an ar archive');
  const out = [];
  let off = 8;
  while (off + 60 <= buf.length) {
    const h = buf.subarray(off, off + 60).toString('latin1');
    const name = h.slice(0, 16).trim();
    const size = Number(h.slice(48, 58).trim());
    out.push({ name, data: buf.subarray(off + 60, off + 60 + size) });
    off += 60 + size + (size % 2);
  }
  return out;
}

// Reads a .tar.gz back into [{name, mode, type, data}].
export function readTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136), 8);
    out.push({ name: str(0, 100), mode: parseInt(str(100, 108), 8), type: str(156, 157), uid: parseInt(str(108, 116), 8), data: tar.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
