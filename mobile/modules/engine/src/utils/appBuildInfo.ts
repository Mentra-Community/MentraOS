import Constants from "expo-constants"

import {packagedBuildInfo, type AppBuildInfo} from "./packagedBuildInfo"

/** PR identity is packaging metadata; official/local builds retain embedded values. */
export function getAppBuildInfo(): AppBuildInfo {
  return packagedBuildInfo(Constants.expoConfig?.extra, {
    appVersion: process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version",
    buildCommit: process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit",
    buildBranch: process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch",
    buildTime: process.env.EXPO_PUBLIC_BUILD_TIME || "time",
    buildUser: process.env.EXPO_PUBLIC_BUILD_USER || "user",
  })
}
