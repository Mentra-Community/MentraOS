const {withEntitlementsPlist} = require("@expo/config-plugins")

/**
 * Remove push notification entitlements for personal Apple Developer teams
 */
const withoutPushNotifications = (config) => {
  return withEntitlementsPlist(config, (config) => {
    delete config.modResults["aps-environment"]
    return config
  })
}

module.exports = withoutPushNotifications
