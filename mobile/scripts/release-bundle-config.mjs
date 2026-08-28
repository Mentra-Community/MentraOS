import {execFileSync} from "node:child_process"
import {appendFile} from "node:fs/promises"

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

// These values are read by shipped JavaScript. Values used only by native
// app.config or unused compatibility entries do not belong in this check.
export const RELEASE_BUNDLE_ENV_KEYS = [
  "EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY",
  "EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID",
  "EXPO_PUBLIC_ASG_OTA_VERSION_URL",
  "EXPO_PUBLIC_AUTHING_APP_HOST",
  "EXPO_PUBLIC_AUTHING_APP_ID",
  "EXPO_PUBLIC_BUILD_BRANCH",
  "EXPO_PUBLIC_BUILD_COMMIT",
  "EXPO_PUBLIC_BUILD_TIME",
  "EXPO_PUBLIC_BUILD_USER",
  "EXPO_PUBLIC_CLOUD_CORE_URL",
  "EXPO_PUBLIC_CLOUD_STORE_URL",
  "EXPO_PUBLIC_CLOUD_RUNTIME_URL",
  "EXPO_PUBLIC_DEPLOYMENT_REGION",
  "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "EXPO_PUBLIC_MENTRAOS_VERSION",
  "EXPO_PUBLIC_POSTHOG_API_KEY",
  "EXPO_PUBLIC_SENTRY_DSN",
]

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function xcodeEnvironmentEntries(env, nodeBinary) {
  const entries = Object.entries(env)
    .filter(([key, value]) => key.startsWith("EXPO_PUBLIC_") && value != null && String(value) !== "")
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right))

  if (env.MENTRAOS_NATIVE_MARKETING_VERSION) {
    entries.push(["MENTRAOS_NATIVE_MARKETING_VERSION", String(env.MENTRAOS_NATIVE_MARKETING_VERSION)])
  }
  if (env.MENTRAOS_PINNED_BUILD_NUMBER) {
    entries.push(["MENTRAOS_PINNED_BUILD_NUMBER", String(env.MENTRAOS_PINNED_BUILD_NUMBER)])
  }
  if (env.NODE_ENV) {
    entries.push(["NODE_ENV", String(env.NODE_ENV)])
  }
  entries.push(["NODE_BINARY", nodeBinary])

  return entries
}

export function xcodeEnvironmentExports(env, nodeBinary) {
  const entries = xcodeEnvironmentEntries(env, nodeBinary)

  return entries.map(([key, value]) => `export ${key}=${shellQuote(value)}`)
}

export function xcodeBuildSettings(env, nodeBinary) {
  return xcodeEnvironmentEntries(env, nodeBinary).map(([key, value]) => `${key}=${value}`)
}

export async function appendXcodeEnvironment(filePath, env, nodeBinary) {
  const exports = xcodeEnvironmentExports(env, nodeBinary)
  await appendFile(filePath, `\n# Exported for child processes launched by Xcode.\n${exports.join("\n")}\n`)
  return exports.length
}

export function assertBundleEnvironment(bundle, env, platform) {
  const missing = RELEASE_BUNDLE_ENV_KEYS.filter((key) => {
    const value = env[key]
    return value != null && String(value) !== "" && !bundle.includes(Buffer.from(String(value)))
  })

  if (missing.length > 0) {
    throw new Error(`${platform} release JS bundle is missing expected build configuration: ${missing.join(", ")}`)
  }
}

export function validateReleaseArchive(archivePath, platform, env = process.env) {
  const entry = platform === "iOS" ? "Payload/*.app/main.jsbundle" : "assets/index.android.bundle"
  let bundle
  try {
    bundle = execFileSync("unzip", ["-p", archivePath, entry], {
      encoding: null,
      maxBuffer: MAX_BUNDLE_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    throw new Error(`Could not read ${platform} release JS bundle from ${archivePath}`, {cause: error})
  }

  if (bundle.length === 0) {
    throw new Error(`${platform} release JS bundle is empty in ${archivePath}`)
  }
  assertBundleEnvironment(bundle, env, platform)
}
