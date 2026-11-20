import {appendFileSync} from "node:fs"
import {getBuildNumber} from "../../mobile/scripts/build-number.mjs"

// The same stable compilation environment on both platforms. The build's own
// values (identity, commit, OTA manifest) are packaged in app.config after the
// compile (pr_mobile_config.py); the local-build fallbacks the JS would inline
// are blanked so a compile is reusable.
const env = {
  MENTRAOS_PINNED_BUILD_NUMBER: String(getBuildNumber()),
  EXPO_PUBLIC_MENTRAOS_VERSION: "",
  EXPO_PUBLIC_BUILD_BRANCH: "",
  EXPO_PUBLIC_BUILD_COMMIT: "",
  EXPO_PUBLIC_BUILD_USER: "",
  EXPO_PUBLIC_BUILD_TIME: "",
  EXPO_PUBLIC_ASG_OTA_VERSION_URL: "",
  NODE_ENV: "production",
}
appendFileSync(
  process.env.GITHUB_ENV,
  Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(""),
)
