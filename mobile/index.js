// Headless recovery needs UDP encryption before any UI module is loaded.
require("react-native-get-random-values")

// Register recovery before Expo Router so Android can boot without an Activity.
const {AppRegistry} = require("react-native")

AppRegistry.registerHeadlessTask("MentraRuntimeRecovery", () => async () => {
  const {recoverBackgroundRuntime} = require("./src/services/backgroundRecovery")
  await recoverBackgroundRuntime()
})

require("expo-router/entry")
