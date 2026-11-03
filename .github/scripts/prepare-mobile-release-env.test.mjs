import assert from "node:assert/strict"
import test from "node:test"

import {prepareMobileReleaseEnvironment} from "./prepare-mobile-release-env.mjs"

const plan = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  channel: "beta",
  products: {mentraos: "3.1.0-beta.57"},
  native: {marketingVersion: "3.1.0", buildNumber: 310000057},
}

const doppler = {
  DOPPLER_CONFIG: "stg",
  EXPO_PUBLIC_CLOUD_CORE_URL: "https://core.staging.us-west-2.mentraglass.com",
  EXPO_PUBLIC_CLOUD_RUNTIME_URL: "https://runtime.staging.us-west-2.mentraglass.com",
  EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.example",
  EXPO_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  EXPO_PUBLIC_MINIAPPS_URL: "https://miniapps.staging.mentraglass.com/",
  MAPBOX_DOWNLOADS_TOKEN: "sk.secret",
}

const input = {plan, doppler, backendEnvironment: "staging", otaManifestUrl: "https://example.com/ota.json"}

test("writes Doppler values and the release identity, and nothing else", () => {
  const {env, masked} = prepareMobileReleaseEnvironment(input)

  assert.match(env, /^EXPO_PUBLIC_MENTRAOS_VERSION=3\.1\.0-beta\.57$/m)
  assert.match(env, /^MENTRAOS_NATIVE_MARKETING_VERSION=3\.1\.0$/m)
  assert.match(env, /^MENTRAOS_PINNED_BUILD_NUMBER=310000057$/m)
  assert.match(env, /^EXPO_PUBLIC_BUILD_ENV=staging$/m)
  assert.match(env, /^EXPO_PUBLIC_ASG_OTA_VERSION_URL=https:\/\/example\.com\/ota\.json$/m)
  assert.match(env, /^EXPO_PUBLIC_CLOUD_CORE_URL=https:\/\/core\.staging\.us-west-2\.mentraglass\.com$/m)
  assert.match(env, /^EXPO_PUBLIC_MINIAPPS_URL=https:\/\/miniapps\.staging\.mentraglass\.com\/$/m)
  assert.match(env, /^EXPO_PUBLIC_DIRECTORY_URL=https:\/\/api\.apps\.staging\.mentraglass\.com\/$/m)
  assert.match(env, /^EXPO_PUBLIC_SENTRY_DSN=https:\/\/public@example\.ingest\.sentry\.io\/1$/m)
  assert.doesNotMatch(env, /DOPPLER_CONFIG|MAPBOX_DOWNLOADS_TOKEN|sk\.secret/)
  assert.deepEqual(masked, ["pk.example", "https://public@example.ingest.sentry.io/1"])
})

test("fails when Doppler lacks a required value", () => {
  assert.throws(
    () =>
      prepareMobileReleaseEnvironment({
        ...input,
        doppler: {...doppler, EXPO_PUBLIC_MINIAPPS_URL: undefined, EXPO_PUBLIC_SENTRY_DSN: " "},
      }),
    /Missing or empty release environment values: EXPO_PUBLIC_SENTRY_DSN, EXPO_PUBLIC_MINIAPPS_URL$/,
  )
  assert.throws(
    () =>
      prepareMobileReleaseEnvironment({
        ...input,
        doppler: {...doppler, EXPO_PUBLIC_CLOUD_CORE_URL: "http://core.example"},
      }),
    /EXPO_PUBLIC_CLOUD_CORE_URL must be credential-free HTTPS/,
  )
})

test("requires beta builds to target staging services", () => {
  assert.throws(
    () => prepareMobileReleaseEnvironment({...input, backendEnvironment: "prod"}),
    /beta mobile releases must target the staging backend/,
  )
})

test("renders production candidates from production plans", () => {
  const {env} = prepareMobileReleaseEnvironment({
    ...input,
    plan: {
      ...plan,
      releaseIdentity: "3.1.0",
      releaseSetId: "mentra-3.1.0",
      channel: "production",
      products: {mentraos: "3.1.0"},
      native: {...plan.native, buildNumber: 310000099},
    },
    backendEnvironment: "prod",
  })
  assert.match(env, /^EXPO_PUBLIC_BUILD_ENV=prod$/m)
  assert.match(env, /^EXPO_PUBLIC_DIRECTORY_URL=https:\/\/api\.apps\.mentraglass\.com\/$/m)
  assert.match(env, /^MENTRAOS_PINNED_BUILD_NUMBER=310000099$/m)
})

test("rejects a mismatched backend and invalid OTA URLs", () => {
  assert.throws(
    () => prepareMobileReleaseEnvironment({...input, otaManifestUrl: "http://example.com/ota.json"}),
    /must be credential-free HTTPS/,
  )
  assert.throws(
    () => prepareMobileReleaseEnvironment({...input, backendEnvironment: "qa"}),
    /must target the staging backend/,
  )
})
