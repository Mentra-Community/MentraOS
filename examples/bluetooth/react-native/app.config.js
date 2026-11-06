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
  if (process.env.MENTRA_PR_MOBILE_FINGERPRINT) {
    const mentraPrBuild = {
      schemaVersion: 1,
      mobileFingerprint: process.env.MENTRA_PR_MOBILE_FINGERPRINT,
      mobileSourceCommit: process.env.MENTRA_PR_BUILD_SHA,
      otaManifestUrl: '',
    }
    config = {...config, extra: {...config.extra, mentraPrBuild}}
  }

  const engineManifest = require.resolve('@mentra/engine/package.json')
  const engineRequire = createRequire(engineManifest)
  const engine = engineRequire(engineManifest)

  // Older release families do not include ACS. When Engine owns it, resolve
  // its plugin from that same dependency tree, including non-hoisted installs.
  if (!engine.dependencies?.['@mentra/acs-meeting']) return config

  return {
    ...config,
    plugins: [...(config.plugins ?? []), engineRequire.resolve('@mentra/acs-meeting/app.plugin.js')],
  }
}
