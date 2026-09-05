const {createRequire} = require('node:module')

module.exports = ({config}) => {
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
