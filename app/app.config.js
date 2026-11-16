// Expo reads app.json first and hands it here as `config`; everything stays in app.json except
// what is computed from it.
//
// android.versionCode (16.11.2026): Android installs a new apk over the old one (keeping the
// person's data) when the signing key matches; the versionCode tells it which build is newer and
// stops an older apk from replacing a newer one. It comes from expo.version, so bumping the
// version is the only step: major*10000 + minor*100 + patch, e.g. 0.5.1 -> 501, 1.2.3 -> 10203.
// Every apk before this one carried versionCode 1, so any version from 0.0.2 on updates over them.
function versionCode(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) throw new Error(`app.json expo.version must be major.minor.patch, got "${version}"`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`versionCode leaves two digits for minor and patch, got ${version}`);
  return major * 10000 + minor * 100 + patch;
}

module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, versionCode: versionCode(config.version) },
});

module.exports.versionCode = versionCode;
