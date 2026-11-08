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
  fs.cpSync(from, to, { recursive: true });
  console.log(`  • kula-node packages copied to ${to}`);
};
