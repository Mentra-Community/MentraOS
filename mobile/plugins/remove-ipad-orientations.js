const {withInfoPlist} = require("@expo/config-plugins")

module.exports = function withRemoveIpadOrientations(config) {
  return withInfoPlist(config, config => {
    // Remove iPad-specific orientations
    delete config.modResults["UISupportedInterfaceOrientations~ipad"]

    return config
  })
}
