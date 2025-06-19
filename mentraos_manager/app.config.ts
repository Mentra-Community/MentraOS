/**
 * Use ts-node here so we can use TypeScript for our Config Plugins
 * and not have to compile them to JavaScript
 */
import dotenv from "dotenv"

import {ExpoConfig, ConfigContext} from "@expo/config"

require("ts-node/register")
dotenv.config()

/**
 * @param config ExpoConfig coming from the static config app.json if it exists
 *
 * You can read more about Expo's Configuration Resolution Rules here:
 * https://docs.expo.dev/workflow/configuration/#configuration-resolution-rules
 */
module.exports = ({config}: ConfigContext): Partial<ExpoConfig> => {
  const existingPlugins = config.plugins ?? []

  return {
    ...config,
    plugins: [...existingPlugins, require("./plugins/withSplashScreen").withSplashScreen],
    extra: {
      MENTRAOS_VERSION: process.env.MENTRAOS_VERSION,
      MENTRAOS_APPSTORE_URL: process.env.MENTRAOS_APPSTORE_URL,
    },
  }
}
