// electron-builder leaves node_modules out of extraResources whatever the filter says; kula-node
// needs its three runtime packages (bonjour-service, qrcode-terminal, ws) next to it, so they
// are copied in after packing, before signing and the dmg.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  const resources = ctx.electronPlatformName === 'darwin'
    ? path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const from = path.join(__dirname, '..', 'build', 'kula-node', 'node_modules');
  const to = path.join(resources, 'kula-node', 'node_modules');
  // .bin holds symlinks to absolute paths on the machine that packed it: useless in the app,
  // and codesign rejects a bundle whose links point outside it
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.bin' });
  console.log(`  • kula-node packages copied to ${to}`);
  // with no developer identity electron-builder signs nothing, and the bundle is left with only
  // electron's linker signature, which no longer covers its resources: apple silicon then calls
  // the downloaded app "damaged". an ad-hoc signature over the whole bundle (10.11.2026) makes it
  // the usual "unverified developer" case instead, which right-click → open gets past.
  if (ctx.electronPlatformName === 'darwin') {
    const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
    require('node:child_process').execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    require('node:child_process').execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log(`  • ${path.basename(app)} signed ad hoc`);
  }
};
