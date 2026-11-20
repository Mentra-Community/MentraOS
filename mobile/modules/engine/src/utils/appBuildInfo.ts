import Constants from "expo-constants"

import {packagedBuildInfo, type AppBuildInfo} from "./packagedBuildInfo"

/** The app's identity: packaged for CI builds, a local developer build's .env otherwise. */
export function getAppBuildInfo(): AppBuildInfo {
  return packagedBuildInfo(Constants.expoConfig?.extra, {
    appVersion: process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version",
    buildCommit: process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit",
    buildBranch: process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch",
    buildTime: process.env.EXPO_PUBLIC_BUILD_TIME || "time",
    buildUser: process.env.EXPO_PUBLIC_BUILD_USER || "user",
  })
}
