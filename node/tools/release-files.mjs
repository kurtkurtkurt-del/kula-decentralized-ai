#!/usr/bin/env node
// The release files around the binaries tools/pack.mjs made:
//
//   node tools/release-files.mjs <dir>     in <dir> (holding kula-node-<target> binaries):
//       kula-node_<version>_<arch>.deb for each linux binary, the homebrew formula and
//       winget manifests with real sha256s, then sha256sums.txt over everything
//   node tools/release-files.mjs --drafts  re-renders the checked-in drafts under
//       packaging/ (placeholders instead of sha256s) from node/package.json
//
// The version always comes from node/package.json.
import fs from 'node:fs';
import path from 'node:path';
import {
  NODE_DIR, TARGETS, DEB_ARCH, binaryName, readVersion, makeDeb, readAr, sha256File, formatSums, renderFormula, renderWinget,
} from './packlib.mjs';

const REPO_ROOT = path.dirname(NODE_DIR);

function writeDrafts(version) {
  const brew = path.join(REPO_ROOT, 'packaging', 'homebrew');
  const winget = path.join(REPO_ROOT, 'packaging', 'winget');
  fs.mkdirSync(brew, { recursive: true });
  fs.mkdirSync(winget, { recursive: true });
  fs.writeFileSync(path.join(brew, 'kula-node.rb'), renderFormula(version));
  for (const [name, text] of Object.entries(renderWinget(version))) fs.writeFileSync(path.join(winget, name), text);
  console.log(`drafts for ${version} written under packaging/`);
}

async function releaseDir(dir, version) {
  const sumsOf = async () => {
    const m = new Map();
    for (const f of fs.readdirSync(dir).sort()) {
      if (f === 'sha256sums.txt' || fs.statSync(path.join(dir, f)).isDirectory()) continue;
      m.set(f, await sha256File(path.join(dir, f)));
    }
    return m;
  };
  const binaries = Object.keys(TARGETS).filter((t) => fs.existsSync(path.join(dir, binaryName(t))));
  if (!binaries.length) throw new Error(`no kula-node-<target> binaries in ${dir}`);
  for (const t of binaries.filter((x) => DEB_ARCH[x])) {
    const deb = makeDeb({ version, target: t, binary: fs.readFileSync(path.join(dir, binaryName(t))) });
    readAr(deb.data); // reads back, or throws
    fs.writeFileSync(path.join(dir, deb.name), deb.data);
    console.log(`${deb.name} (${(deb.data.length / 1e6).toFixed(1)} MB)`);
  }
  const sums = await sumsOf();
  fs.writeFileSync(path.join(dir, 'kula-node.rb'), renderFormula(version, sums));
  for (const [name, text] of Object.entries(renderWinget(version, sums))) fs.writeFileSync(path.join(dir, name), text);
  const all = await sumsOf();
  fs.writeFileSync(path.join(dir, 'sha256sums.txt'), formatSums(all));
  console.log(`sha256sums.txt: ${all.size} files (binaries: ${binaries.join(', ')})`);
}

const arg = process.argv[2];
const version = readVersion();
if (arg === '--drafts') writeDrafts(version);
else if (arg && !arg.startsWith('-')) await releaseDir(path.resolve(arg), version);
else { console.error('usage: node tools/release-files.mjs <dir> | --drafts'); process.exit(2); }
