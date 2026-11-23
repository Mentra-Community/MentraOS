import {execFileSync} from "node:child_process"
import {appendFile} from "node:fs/promises"

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024

// The packaged build config's inputs (app.config.ts's mentraBuild), which Xcode's
// build phases read when they generate app.config.
const BUILD_CONFIG_KEYS = [
  "MENTRA_MOBILE_FINGERPRINT",
  "MENTRA_MOBILE_SOURCE_COMMIT",
  "MENTRA_OTA_MANIFEST_URL",
  "MENTRA_APP_IDENTITY",
  "MENTRA_BUILD_COMMIT",
  "MENTRA_BUILD_BRANCH",
  "MENTRA_BUILD_TIME",
  "MENTRA_BUILD_USER",
]

// These values are read by shipped JavaScript. Values used only by native
// app.config or unused compatibility entries do not belong in this check. A
// build's own values (OTA manifest, identity, build info) are not in the bundle:
// they are packaged in app.config (BUILD_CONFIG_KEYS).
export const RELEASE_BUNDLE_ENV_KEYS = [
  "EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY",
  "EXPO_PUBLIC_AR99_RELEASE_DEVELOPER_ID",
  "EXPO_PUBLIC_AUTHING_APP_HOST",
  "EXPO_PUBLIC_AUTHING_APP_ID",
  "EXPO_PUBLIC_CLOUD_CORE_URL",
  "EXPO_PUBLIC_CLOUD_RUNTIME_URL",
  "EXPO_PUBLIC_DEPLOYMENT_REGION",
  "EXPO_PUBLIC_DIRECTORY_URL",
  "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "EXPO_PUBLIC_MINIAPPS_URL",
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

  for (const key of BUILD_CONFIG_KEYS) if (env[key]) entries.push([key, String(env[key])])
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

// Glasses usage analytics live in the Bluetooth SDK's native code, not in the
// JS bundle. The app has no PostHog client of its own any more, so a PostHog
// project token in the bundle means a dependency or a stray key crept back in.
const POSTHOG_PROJECT_TOKEN_PATTERN = /phc_[A-Za-z0-9]{20,}/

export function assertNoAppAnalyticsToken(bundle, platform) {
  const match = bundle.toString("latin1").match(POSTHOG_PROJECT_TOKEN_PATTERN)
  if (match) {
    throw new Error(
      `${platform} release JS bundle embeds a PostHog project token (${match[0].slice(
        0,
        8,
      )}…); app-level PostHog was removed, glasses analytics ship in the Bluetooth SDK`,
    )
  }
}

/** The release's OTA manifest and identity are the ones packaged in the archive's app.config. */
export function assertPackagedBuild(config, env, platform) {
  const build = config?.extra?.mentraBuild
  if (
    build?.schemaVersion !== 2 ||
    build.otaManifestUrl !== env.MENTRA_OTA_MANIFEST_URL ||
    build.identity !== env.MENTRA_APP_IDENTITY
  ) {
    throw new Error(`${platform} release app.config does not package the release's OTA manifest and identity`)
  }
}

function readArchiveEntry(archivePath, entry, platform) {
  try {
    return execFileSync("unzip", ["-p", archivePath, entry], {
      encoding: null,
      maxBuffer: MAX_BUNDLE_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    throw new Error(`Could not read ${entry} from ${platform} release ${archivePath}`, {cause: error})
  }
}

export function validateReleaseArchive(archivePath, platform, env = process.env) {
  const [bundleEntry, configEntry] =
    platform === "iOS"
      ? ["Payload/*.app/main.jsbundle", "Payload/*.app/EXConstants.bundle/app.config"]
      : ["assets/index.android.bundle", "assets/app.config"]
  const bundle = readArchiveEntry(archivePath, bundleEntry, platform)

  if (bundle.length === 0) {
    throw new Error(`${platform} release JS bundle is empty in ${archivePath}`)
  }
  assertBundleEnvironment(bundle, env, platform)
  assertNoAppAnalyticsToken(bundle, platform)
  assertPackagedBuild(JSON.parse(readArchiveEntry(archivePath, configEntry, platform).toString("utf8")), env, platform)
}
