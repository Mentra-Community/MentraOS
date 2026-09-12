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

test("separates the observable release identity from native store version fields", () => {
  const output = prepareMobileReleaseEnvironment({
    plan,
    template: "EXPO_PUBLIC_MENTRAOS_VERSION=old\nEXPO_PUBLIC_CLOUD_CORE_URL=old\n",
    backendEnvironment: "staging",
    otaManifestUrl: "https://example.com/ota.json",
    publicValues: {
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.example",
      EXPO_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    },
  })

  assert.match(output, /^EXPO_PUBLIC_MENTRAOS_VERSION=3\.1\.0-beta\.57$/m)
  assert.match(output, /^MENTRAOS_NATIVE_MARKETING_VERSION=3\.1\.0$/m)
  assert.match(output, /^MENTRAOS_PINNED_BUILD_NUMBER=310000057$/m)
  assert.match(output, /^EXPO_PUBLIC_BUILD_ENV=staging$/m)
  assert.match(output, /^EXPO_PUBLIC_CLOUD_CORE_URL=https:\/\/core\.staging\.us-west-2\.mentraglass\.com$/m)
  assert.match(output, /^EXPO_PUBLIC_CLOUD_RUNTIME_URL=https:\/\/runtime\.staging\.us-west-2\.mentraglass\.com$/m)
})

test("requires beta builds to target staging services", () => {
  assert.throws(
    () =>
      prepareMobileReleaseEnvironment({
        plan,
        template: "EXPO_PUBLIC_MENTRAOS_VERSION=old\n",
        backendEnvironment: "prod",
        otaManifestUrl: "https://artifacts.example.com/ota.json",
        publicValues: {EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.test", EXPO_PUBLIC_SENTRY_DSN: "https://sentry.example/1"},
      }),
    /beta mobile releases must target the staging backend/,
  )
})

test("renders production candidates from production plans and endpoints", () => {
  const output = prepareMobileReleaseEnvironment({
    plan: {
      ...plan,
      releaseIdentity: "3.1.0",
      releaseSetId: "mentra-3.1.0",
      channel: "production",
      products: {mentraos: "3.1.0"},
      native: {...plan.native, buildNumber: 310000099},
    },
    template: "",
    backendEnvironment: "prod",
    otaManifestUrl: "https://example.com/ota.json",
    publicValues: {
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.example",
      EXPO_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    },
  })
  assert.match(output, /^EXPO_PUBLIC_BUILD_ENV=prod$/m)
  assert.match(output, /^EXPO_PUBLIC_CLOUD_CORE_URL=https:\/\/core\.us-west-2\.mentraglass\.com$/m)
  assert.match(output, /^EXPO_PUBLIC_CLOUD_RUNTIME_URL=https:\/\/runtime\.us-west-2\.mentraglass\.com$/m)
  assert.match(output, /^MENTRAOS_PINNED_BUILD_NUMBER=310000099$/m)
})

test("rejects a mismatched backend and invalid OTA URLs", () => {
  const input = {
    plan,
    template: "",
    backendEnvironment: "staging",
    otaManifestUrl: "http://example.com/ota.json",
    publicValues: {EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "pk.example", EXPO_PUBLIC_SENTRY_DSN: "https://example.com/1"},
  }
  assert.throws(() => prepareMobileReleaseEnvironment(input), /must be credential-free HTTPS/)
  assert.throws(
    () => prepareMobileReleaseEnvironment({...input, otaManifestUrl: "https://example.com", backendEnvironment: "qa"}),
    /must target the staging backend/,
  )
})
