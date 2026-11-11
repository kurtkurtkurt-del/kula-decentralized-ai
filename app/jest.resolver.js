// Jest's resolver: react native's own (the jest-expo preset's), and one thing more. god's eye is
// shared with kula-node (../node/src/godseye, docs/BEYIN.md) and written as node ESM, so its files
// import each other as './types.js' for './types.ts'. Only inside that folder is a relative '.js'
// read as its '.ts', and a package there comes from the app's node_modules; metro.config.js does
// the same for the app bundle.
const path = require('path');
const rn = require('@react-native/jest-preset/jest/resolver.js');

const GODSEYE = path.resolve(__dirname, '../node/src/godseye') + path.sep;

module.exports = (request, options) => {
  if (options.basedir && (options.basedir + path.sep).startsWith(GODSEYE)) {
    if (/^\.\.?\/.*\.js$/.test(request)) return rn(request.slice(0, -3) + '.ts', options);
    // a package (babel's helpers: the eye imports none) is the app's, never node/node_modules'
    if (!request.startsWith('.') && !path.isAbsolute(request)) return rn(request, { ...options, basedir: __dirname });
  }
  return rn(request, options);
};
