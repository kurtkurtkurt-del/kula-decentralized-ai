// Metro: bundle the intro film (assets/film/film.html) into the app as an asset.
// For the web build only, native-only modules resolve to the stand-ins in src/web/.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('html');

const web = (f) => path.join(__dirname, 'src/web', f);
const webOnly = {
  'expo-sqlite/kv-store': web('kv-store.ts'),
  'expo-sqlite/localStorage/install': web('empty.ts'),
  'expo-secure-store': web('secure-store.ts'),
  'react-native-webview': web('WebView.tsx'),
  'expo-apple-authentication': web('apple.ts'),
  'expo-notifications': web('notifications.ts'),
  'expo-device': web('device.ts'),
  'expo-navigation-bar': web('navigation-bar.ts'),
  'expo-file-system': web('file-system.ts'),
};

// god's eye (docs/BEYIN.md "one eye, two homes"): one source with kula-node, never a copy. The
// app imports it as @godseye/* (tsconfig paths) from ../node/src/godseye; Metro watches that one
// folder, and inside it a relative './x.js' is read as './x.ts' (the files are node ESM) and a
// package comes from the app's node_modules.
// jest.resolver.js does the same for the tests.
const GODSEYE = path.resolve(__dirname, '../node/src/godseye');
config.watchFolders = [...(config.watchFolders ?? []), GODSEYE];

config.resolver.resolveRequest = (context, name, platform) => {
  if (platform === 'web' && webOnly[name]) return { type: 'sourceFile', filePath: webOnly[name] };
  if (name.startsWith('@godseye/')) return context.resolveRequest(context, path.join(GODSEYE, name.slice('@godseye/'.length)), platform);
  if (context.originModulePath.startsWith(GODSEYE + path.sep)) {
    if (/^\.\.?\/.*\.js$/.test(name)) return context.resolveRequest(context, name.slice(0, -3), platform);
    // a package (only babel's helpers: the eye imports none) is the app's, never node/node_modules'
    if (!name.startsWith('.') && !path.isAbsolute(name)) return context.resolveRequest({ ...context, originModulePath: path.join(__dirname, 'package.json') }, name, platform);
  }
  return context.resolveRequest(context, name, platform);
};

module.exports = config;
