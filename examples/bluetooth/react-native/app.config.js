const {createRequire} = require('node:module')

module.exports = ({config}) => {
  // Set a team-owned identifier before prebuild when signing outside Mentra.
  // Leaving this unset preserves the committed TestFlight and CI identifier.
  const bundleIdentifier = (process.env.MENTRA_IOS_BUNDLE_ID || '').trim()
  if (bundleIdentifier) {
    config = {...config, ios: {...config.ios, bundleIdentifier}}
  }

  const engineManifest = require.resolve('@mentra/engine/package.json')
  const engineRequire = createRequire(engineManifest)
  const engine = engineRequire(engineManifest)

  // Crust (the miniapp runtime the Engine loads at startup) and ACS belong to
  // Engine: resolve their plugins from its dependency tree, including
  // non-hoisted installs. Older release families do not include ACS.
  const plugins = ['@mentra/crust', '@mentra/acs-meeting']
    .filter((name) => engine.dependencies?.[name])
    .map((name) => engineRequire.resolve(`${name}/app.plugin.js`))

  if (!plugins.length) return config
  return {...config, plugins: [...(config.plugins ?? []), ...plugins]}
}
