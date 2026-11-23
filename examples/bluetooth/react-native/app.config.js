const {createRequire} = require('node:module')

module.exports = ({config}) => {
  // Set a team-owned identifier before prebuild when signing outside Mentra.
  // Leaving this unset preserves the committed TestFlight and CI identifier.
  const bundleIdentifier = (process.env.MENTRA_IOS_BUNDLE_ID || '').trim()
  if (bundleIdentifier) {
    config = {...config, ios: {...config.ios, bundleIdentifier}}
  }

  // CI pins the release's marketing version (Android versionName, iOS
  // CFBundleShortVersionString) and build number (versionCode,
  // CFBundleVersion), as for the Mentra App. A PR build also carries the
  // contract its packaging checks and fills in (.github/scripts/pr_mobile_config.py).
  const version = (process.env.MENTRAOS_NATIVE_MARKETING_VERSION || '').trim()
  if (version) config = {...config, version}
  const buildNumber = Number(process.env.MENTRAOS_PINNED_BUILD_NUMBER || 0)
  if (buildNumber) {
    config = {
      ...config,
      android: {...config.android, versionCode: buildNumber},
      ios: {...config.ios, buildNumber: String(buildNumber)},
    }
  }
  // A CI build's own values, written after the compile by the shared packaging (pr_mobile_config.py).
  if (process.env.MENTRA_MOBILE_FINGERPRINT) {
    const mentraBuild = {
      schemaVersion: 2,
      mobileFingerprint: process.env.MENTRA_MOBILE_FINGERPRINT,
      mobileSourceCommit: process.env.MENTRA_MOBILE_SOURCE_COMMIT,
      otaManifestUrl: '',
      identity: config.version,
      buildInfo: '',
      buildNumber,
    }
    config = {...config, extra: {...config.extra, mentraBuild}}
  }

  const engineManifest = require.resolve('@mentra/engine/package.json')
  const engineRequire = createRequire(engineManifest)
  const engine = engineRequire(engineManifest)

  // Crust (the miniapp runtime the Call tab runs on) and ACS belong to Engine:
  // resolve their plugins from its dependency tree, including non-hoisted
  // installs. Older release families do not include ACS.
  const plugins = ['@mentra/crust', '@mentra/acs-meeting']
    .filter((name) => engine.dependencies?.[name])
    .map((name) => engineRequire.resolve(`${name}/app.plugin.js`))

  if (!plugins.length) return config
  return {...config, plugins: [...(config.plugins ?? []), ...plugins]}
}
