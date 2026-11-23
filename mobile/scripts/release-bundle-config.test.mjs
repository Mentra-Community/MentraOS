import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import test from "node:test"

import {
  RELEASE_BUNDLE_ENV_KEYS,
  assertBundleEnvironment,
  assertNoAppAnalyticsToken,
  assertPackagedBuild,
  xcodeBuildSettings,
  xcodeEnvironmentExports,
} from "./release-bundle-config.mjs"

test("xcodeEnvironmentExports exports public and pinned build values safely", () => {
  const lines = xcodeEnvironmentExports(
    {
      EXPO_PUBLIC_CLOUD_CORE_URL: "https://example.test/it's-core",
      EXPO_PUBLIC_EMPTY: "",
      MENTRAOS_NATIVE_MARKETING_VERSION: "3.1.0",
      MENTRAOS_PINNED_BUILD_NUMBER: "123",
      NODE_ENV: "production",
      PRIVATE_SECRET: "do-not-export",
    },
    "/opt/node with spaces/bin/node",
  )

  assert.deepEqual(lines, [
    `export EXPO_PUBLIC_CLOUD_CORE_URL='https://example.test/it'"'"'s-core'`,
    "export MENTRAOS_NATIVE_MARKETING_VERSION='3.1.0'",
    "export MENTRAOS_PINNED_BUILD_NUMBER='123'",
    "export NODE_ENV='production'",
    "export NODE_BINARY='/opt/node with spaces/bin/node'",
  ])

  const output = execFileSync(
    "sh",
    ["-c", `${lines.join("\n")}\nprintf '%s\\n' \"$EXPO_PUBLIC_CLOUD_CORE_URL\"`],
    {
      encoding: "utf8",
    },
  )
  assert.equal(output.trim(), "https://example.test/it's-core")
})

test("xcodeBuildSettings exposes the same public values to every build phase", () => {
  const settings = xcodeBuildSettings(
    {
      EXPO_PUBLIC_CLOUD_CORE_URL: "https://example.test/core?channel=staging build",
      EXPO_PUBLIC_EMPTY: "",
      MENTRAOS_NATIVE_MARKETING_VERSION: "3.1.0",
      MENTRAOS_PINNED_BUILD_NUMBER: 123,
      NODE_ENV: "production",
      PRIVATE_SECRET: "do-not-export",
    },
    "/opt/node with spaces/bin/node",
  )

  assert.deepEqual(settings, [
    "EXPO_PUBLIC_CLOUD_CORE_URL=https://example.test/core?channel=staging build",
    "MENTRAOS_NATIVE_MARKETING_VERSION=3.1.0",
    "MENTRAOS_PINNED_BUILD_NUMBER=123",
    "NODE_ENV=production",
    "NODE_BINARY=/opt/node with spaces/bin/node",
  ])
})

test("Xcode's config regeneration receives the packaged build config's inputs", () => {
  const commit = "b".repeat(40), fingerprint = "f".repeat(64)
  const env = {MENTRA_MOBILE_FINGERPRINT: fingerprint, MENTRA_MOBILE_SOURCE_COMMIT: commit,
    MENTRA_OTA_MANIFEST_URL: "https://example.test/ota.json", MENTRA_APP_IDENTITY: "3.5.0-beta.1", MENTRA_BUILD_COMMIT: "",
    GITHUB_SHA: "a".repeat(40)}
  assert.deepEqual(xcodeBuildSettings(env, "/usr/bin/node"), [
    `MENTRA_MOBILE_FINGERPRINT=${fingerprint}`,
    `MENTRA_MOBILE_SOURCE_COMMIT=${commit}`,
    "MENTRA_OTA_MANIFEST_URL=https://example.test/ota.json",
    "MENTRA_APP_IDENTITY=3.5.0-beta.1",
    "NODE_BINARY=/usr/bin/node",
  ])
  const output = execFileSync("sh", ["-c",
    `${xcodeEnvironmentExports(env, "/usr/bin/node").join("\n")}\nprintf '%s' "$MENTRA_MOBILE_SOURCE_COMMIT"`,
  ], {encoding: "utf8"})
  assert.equal(output, commit)
})

test("a release archive packages its own OTA manifest and identity", () => {
  const env = {MENTRA_OTA_MANIFEST_URL: "https://example.test/ota.json", MENTRA_APP_IDENTITY: "3.5.0-beta.1"}
  const config = {extra: {mentraBuild: {schemaVersion: 2, otaManifestUrl: env.MENTRA_OTA_MANIFEST_URL, identity: "3.5.0-beta.1"}}}
  assert.doesNotThrow(() => assertPackagedBuild(config, env, "iOS"))
  for (const build of [undefined, {...config.extra.mentraBuild, otaManifestUrl: ""},
    {...config.extra.mentraBuild, identity: "3.5.0"}, {...config.extra.mentraBuild, schemaVersion: 1}])
    assert.throws(() => assertPackagedBuild({extra: {mentraBuild: build}}, env, "Android"), /OTA manifest and identity/)
})

test("release bundle gate does not require BUILD_TIME so Metro cache reuse cannot fail CI", () => {
  assert.equal(RELEASE_BUNDLE_ENV_KEYS.includes("EXPO_PUBLIC_BUILD_TIME"), false)

  assert.doesNotThrow(() =>
    assertBundleEnvironment(
      Buffer.from("prefix abc1234 suffix"),
      {
        EXPO_PUBLIC_BUILD_COMMIT: "abc1234",
        EXPO_PUBLIC_BUILD_TIME: "2026-08-31_11-27AM",
      },
      "iOS",
    ),
  )
})

test("assertBundleEnvironment accepts expected nonempty runtime values", () => {
  const env = {
    EXPO_PUBLIC_CLOUD_CORE_URL: "https://core.example.test",
    EXPO_PUBLIC_MINIAPPS_URL: "https://miniapps.example.test/",
    EXPO_PUBLIC_SENTRY_DSN: "",
  }
  const bundle = Buffer.from("prefix https://core.example.test https://miniapps.example.test/ suffix")

  assert.doesNotThrow(() => assertBundleEnvironment(bundle, env, "iOS"))
})

test("assertBundleEnvironment reports keys without leaking values", () => {
  const secretValue = "public-client-key-value"

  assert.throws(
    () =>
      assertBundleEnvironment(
        Buffer.from("bundle without expected configuration"),
        {EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY: secretValue},
        "iOS",
      ),
    (error) => {
      assert.match(error.message, /EXPO_PUBLIC_AR99_RELEASE_CLIENT_KEY/)
      assert.doesNotMatch(error.message, new RegExp(secretValue))
      return true
    },
  )
})

test("assertNoAppAnalyticsToken accepts a bundle without a PostHog project token", () => {
  assert.doesNotThrow(() => assertNoAppAnalyticsToken(Buffer.from("var phc=1; api_key: 'not-a-token'"), "iOS"))
  assert.doesNotThrow(() => assertNoAppAnalyticsToken(Buffer.from([0x00, 0xff, 0x70, 0x68, 0x63, 0x5f]), "Android"))
})

test("assertNoAppAnalyticsToken rejects a bundle that embeds a PostHog project token", () => {
  // Synthetic: shaped like a PostHog project token, not a real one.
  const token = `phc_${"Ab3".repeat(15)}`
  const bundle = Buffer.concat([Buffer.from([0x00, 0xff]), Buffer.from(`apiKey:"${token}"`), Buffer.from([0x00])])

  assert.throws(
    () => assertNoAppAnalyticsToken(bundle, "Android"),
    (error) => {
      assert.match(error.message, /Android release JS bundle embeds a PostHog project token/)
      assert.doesNotMatch(error.message, new RegExp(token))
      return true
    },
  )
})
