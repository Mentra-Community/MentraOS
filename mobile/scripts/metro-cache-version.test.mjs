import assert from "node:assert/strict"
import test from "node:test"

import cacheVersion from "./metro-cache-version.cjs"

const {withExpoPublicEnvCacheVersion} = cacheVersion

test("Expo public environment participates in the Metro cache version", () => {
  const first = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_COMMIT: "commit-a",
    EXPO_PUBLIC_BUILD_TIME: "time-a",
  })
  const second = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_COMMIT: "commit-b",
    EXPO_PUBLIC_BUILD_TIME: "time-a",
  })

  assert.notEqual(first, second)
})

test("cache version is stable across environment insertion order", () => {
  const first = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_COMMIT: "commit-a",
    EXPO_PUBLIC_BUILD_TIME: "time-a",
  })
  const second = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_TIME: "time-a",
    EXPO_PUBLIC_BUILD_COMMIT: "commit-a",
  })

  assert.equal(first, second)
})

test("cache version distinguishes missing and empty public values", () => {
  const missing = withExpoPublicEnvCacheVersion("base", {})
  const empty = withExpoPublicEnvCacheVersion("base", {EXPO_PUBLIC_BUILD_COMMIT: ""})

  assert.notEqual(missing, empty)
})

test("cache version ignores private environment and does not expose public values", () => {
  const publicValue = "public-value-that-must-not-appear"
  const first = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_COMMIT: publicValue,
    PRIVATE_SECRET: "private-a",
  })
  const second = withExpoPublicEnvCacheVersion("base", {
    EXPO_PUBLIC_BUILD_COMMIT: publicValue,
    PRIVATE_SECRET: "private-b",
  })

  assert.equal(first, second)
  assert.doesNotMatch(first, new RegExp(publicValue))
})
