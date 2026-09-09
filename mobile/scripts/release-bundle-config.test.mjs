import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import test from "node:test"

import {
  assertBundleEnvironment,
  assertNoAppAnalyticsToken,
  xcodeBuildSettings,
  xcodeEnvironmentExports,
} from "./release-bundle-config.mjs"

test("xcodeEnvironmentExports exports public and pinned build values safely", () => {
  const lines = xcodeEnvironmentExports(
    {
      EXPO_PUBLIC_ASG_OTA_VERSION_URL: "https://example.test/it's-pinned.json",
      EXPO_PUBLIC_EMPTY: "",
      MENTRAOS_NATIVE_MARKETING_VERSION: "3.1.0",
      MENTRAOS_PINNED_BUILD_NUMBER: "123",
      NODE_ENV: "production",
      PRIVATE_SECRET: "do-not-export",
    },
    "/opt/node with spaces/bin/node",
  )

  assert.deepEqual(lines, [
    `export EXPO_PUBLIC_ASG_OTA_VERSION_URL='https://example.test/it'"'"'s-pinned.json'`,
    "export MENTRAOS_NATIVE_MARKETING_VERSION='3.1.0'",
    "export MENTRAOS_PINNED_BUILD_NUMBER='123'",
    "export NODE_ENV='production'",
    "export NODE_BINARY='/opt/node with spaces/bin/node'",
  ])

  const output = execFileSync(
    "sh",
    ["-c", `${lines.join("\n")}\nprintf '%s\\n' \"$EXPO_PUBLIC_ASG_OTA_VERSION_URL\"`],
    {
      encoding: "utf8",
    },
  )
  assert.equal(output.trim(), "https://example.test/it's-pinned.json")
})

test("xcodeBuildSettings exposes the same public values to every build phase", () => {
  const settings = xcodeBuildSettings(
    {
      EXPO_PUBLIC_ASG_OTA_VERSION_URL: "https://example.test/pin.json?channel=staging build",
      EXPO_PUBLIC_EMPTY: "",
      MENTRAOS_NATIVE_MARKETING_VERSION: "3.1.0",
      MENTRAOS_PINNED_BUILD_NUMBER: 123,
      NODE_ENV: "production",
      PRIVATE_SECRET: "do-not-export",
    },
    "/opt/node with spaces/bin/node",
  )

  assert.deepEqual(settings, [
    "EXPO_PUBLIC_ASG_OTA_VERSION_URL=https://example.test/pin.json?channel=staging build",
    "MENTRAOS_NATIVE_MARKETING_VERSION=3.1.0",
    "MENTRAOS_PINNED_BUILD_NUMBER=123",
    "NODE_ENV=production",
    "NODE_BINARY=/opt/node with spaces/bin/node",
  ])
})

test("assertBundleEnvironment accepts expected nonempty runtime values", () => {
  const env = {
    EXPO_PUBLIC_ASG_OTA_VERSION_URL: "https://example.test/pin.json",
    EXPO_PUBLIC_BUILD_COMMIT: "abc1234",
    EXPO_PUBLIC_SENTRY_DSN: "",
  }
  const bundle = Buffer.from("prefix https://example.test/pin.json abc1234 suffix")

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
  const token = "phc_FCweXVAxVgU7wZK4Fk3okOx4RmyNqVHJf62YpZSfJt5"
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
