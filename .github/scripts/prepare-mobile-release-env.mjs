#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

// Values a release takes from the backend's Doppler config (project
// mentra-mobile-client, config dev/stg/prd). There is no fallback: a missing or
// empty value fails the release instead of shipping a checked-in dev value.
const DOPPLER_KEYS = [
  "EXPO_PUBLIC_CLOUD_CORE_URL",
  "EXPO_PUBLIC_CLOUD_RUNTIME_URL",
  "EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "EXPO_PUBLIC_SENTRY_DSN",
  "EXPO_PUBLIC_STORE_URL",
]

function requireHttps(value, label) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return url.toString()
}

export function prepareMobileReleaseEnvironment({plan, doppler, backendEnvironment, otaManifestUrl}) {
  if (plan.releaseSetId !== `mentra-${plan.releaseIdentity}` || plan.products?.mentraos !== plan.releaseIdentity) {
    throw new Error("Release plan does not contain the coordinated MentraOS product")
  }
  if (!Number.isSafeInteger(plan.native?.buildNumber) || plan.native.buildNumber < 1) {
    throw new Error("Release plan has no valid native build number")
  }
  if (plan.native.marketingVersion !== plan.familyBaseVersion) {
    throw new Error("Native marketing version must equal the family base")
  }
  const expectedBackend =
    plan.channel === "dev" ? "dev" : plan.channel === "beta" ? "staging" : plan.channel === "production" ? "prod" : null
  if (!expectedBackend) throw new Error(`Mobile builds do not support channel ${JSON.stringify(plan.channel)}`)
  if (backendEnvironment !== expectedBackend) {
    throw new Error(
      `${plan.channel} mobile releases must target the ${expectedBackend} backend, not ${JSON.stringify(backendEnvironment)}`,
    )
  }
  const values = {
    ...Object.fromEntries(DOPPLER_KEYS.map((key) => [key, doppler[key]])),
    EXPO_PUBLIC_ASG_OTA_VERSION_URL: requireHttps(otaManifestUrl, "OTA manifest URL"),
    EXPO_PUBLIC_BUILD_ENV: backendEnvironment,
    EXPO_PUBLIC_MENTRAOS_VERSION: plan.releaseIdentity,
    MENTRAOS_NATIVE_MARKETING_VERSION: plan.native.marketingVersion,
    MENTRAOS_PINNED_BUILD_NUMBER: String(plan.native.buildNumber),
  }
  const missing = Object.keys(values).filter((key) => typeof values[key] !== "string" || values[key].trim() === "")
  if (missing.length > 0) throw new Error(`Missing or empty release environment values: ${missing.join(", ")}`)
  for (const [key, value] of Object.entries(values)) {
    if (/\r|\n/.test(value)) throw new Error(`${key} must be a single-line value`)
    if (key.endsWith("_URL")) requireHttps(value, key)
  }
  return {
    env: Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    masked: DOPPLER_KEYS.filter((key) => !key.endsWith("_URL")).map((key) => values[key]),
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

// Reads `doppler secrets download --no-file --format json` on stdin.
function main() {
  const args = parseArgs(process.argv.slice(2))
  const {env, masked} = prepareMobileReleaseEnvironment({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    doppler: JSON.parse(readFileSync(0, "utf8")),
    backendEnvironment: args["backend-environment"],
    otaManifestUrl: args["ota-manifest-url"],
  })
  for (const value of masked) console.log(`::add-mask::${value}`)
  writeFileSync(path.resolve(args.output), env)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
