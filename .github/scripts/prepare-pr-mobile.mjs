import {appendFileSync, readFileSync} from "node:fs"
import {getBuildNumber} from "../../mobile/scripts/build-number.mjs"

// The same stable compilation environment and per-run packaging inputs on both
// platforms. No branch/head/time is inlined into reusable JavaScript.
const env = {
  MENTRAOS_PINNED_BUILD_NUMBER: String(getBuildNumber()),
  EXPO_PUBLIC_MENTRAOS_VERSION: JSON.parse(readFileSync("package.json", "utf8")).version,
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
