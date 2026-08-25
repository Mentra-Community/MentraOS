#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const CLOUDS = {
  dev: {
    core: "https://core.dev.us-west-2.mentraglass.com",
    runtime: "https://runtime.dev.us-west-2.mentraglass.com",
  },
  staging: {
    core: "https://core.staging.us-west-2.mentraglass.com",
    runtime: "https://runtime.staging.us-west-2.mentraglass.com",
  },
  prod: {
    core: "https://core.us-west-2.mentraglass.com",
    runtime: "https://runtime.us-west-2.mentraglass.com",
  },
}

function requireHttps(value, label) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return url.toString()
}

function parseEnv(contents) {
  const values = new Map()
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (match) values.set(match[1], match[2])
  }
  return values
}

export function prepareMobileReleaseEnvironment({plan, template, backendEnvironment, otaManifestUrl, publicValues}) {
  if (plan.releaseSetId !== `mentra-${plan.releaseIdentity}` || plan.products?.mentraos !== plan.releaseIdentity) {
    throw new Error("Release plan does not contain the coordinated MentraOS product")
  }
  if (!Number.isSafeInteger(plan.native?.buildNumber) || plan.native.buildNumber < 1) {
    throw new Error("Release plan has no valid native build number")
  }
  if (plan.native.marketingVersion !== plan.familyBaseVersion) {
    throw new Error("Native marketing version must equal the family base")
  }
  const expectedBackend = plan.channel === "dev" ? "dev" : plan.channel === "beta" ? "prod" : null
  if (!expectedBackend) throw new Error(`Mobile prerelease builds do not support channel ${JSON.stringify(plan.channel)}`)
  if (backendEnvironment !== expectedBackend) {
    throw new Error(
      `${plan.channel} mobile releases must target the ${expectedBackend} backend, not ${JSON.stringify(backendEnvironment)}`,
    )
  }
  const cloud = CLOUDS[backendEnvironment]
  if (!cloud) throw new Error(`Unsupported mobile backend environment ${JSON.stringify(backendEnvironment)}`)
  const values = parseEnv(template)
  const updates = {
    EXPO_PUBLIC_ASG_OTA_VERSION_URL: requireHttps(otaManifestUrl, "OTA manifest URL"),
    EXPO_PUBLIC_BUILD_ENV: backendEnvironment,
    EXPO_PUBLIC_CLOUD_CORE_URL: cloud.core,
    EXPO_PUBLIC_CLOUD_RUNTIME_URL: cloud.runtime,
    EXPO_PUBLIC_MENTRAOS_VERSION: plan.releaseIdentity,
    MENTRAOS_NATIVE_MARKETING_VERSION: plan.native.marketingVersion,
    MENTRAOS_PINNED_BUILD_NUMBER: String(plan.native.buildNumber),
    ...publicValues,
  }
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be a non-empty string`)
    if (/\r|\n/.test(value)) throw new Error(`${key} must be a single-line value`)
    values.set(key, value)
  }
  return `${[...values].map(([key, value]) => `${key}=${value}`).join("\n")}\n`
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const envFile = path.resolve(args["env-file"])
  const rendered = prepareMobileReleaseEnvironment({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    template: readFileSync(envFile, "utf8"),
    backendEnvironment: args["backend-environment"],
    otaManifestUrl: args["ota-manifest-url"],
    publicValues: {
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: args["mapbox-public-token"],
      EXPO_PUBLIC_SENTRY_DSN: args["sentry-dsn"],
    },
  })
  writeFileSync(envFile, rendered)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
