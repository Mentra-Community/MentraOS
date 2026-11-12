import assert from "node:assert/strict"
import test from "node:test"

import {localAppVersion, resolveBuildUser} from "./set-build-env.mjs"

test("uses the GitHub actor for CI build metadata", () => {
  assert.equal(
    resolveBuildUser({
      githubActor: "mentra release bot",
      readGitUsername: () => {
        throw new Error("Git config should not be read")
      },
    }),
    "mentra_release_bot",
  )
})

test("falls back to the local Git username outside CI", () => {
  assert.equal(resolveBuildUser({githubActor: "", readGitUsername: () => "Philippe Ferreira\n"}), "Philippe_Ferreira")
})

test("does not fail a build when Git user.name is unset", () => {
  assert.equal(
    resolveBuildUser({
      githubActor: null,
      readGitUsername: () => {
        throw new Error("missing git user.name")
      },
    }),
    "unknown",
  )
})

test("a local build takes the app version from package.json over a stale .env", () => {
  assert.equal(
    localAppVersion({
      env: {EXPO_PUBLIC_MENTRAOS_VERSION: "2.8.0"},
      dotenvVersion: "2.8.0",
      readPackageVersion: () => "3.4.0",
    }),
    "3.4.0",
  )
  assert.equal(localAppVersion({env: {}, readPackageVersion: () => "3.4.0"}), "3.4.0")
})

test("CI and an exported app version keep their own", () => {
  const readPackageVersion = () => {
    throw new Error("package.json should not be read")
  }
  assert.equal(
    localAppVersion({env: {CI: "true", EXPO_PUBLIC_MENTRAOS_VERSION: "3.4.0-beta.57"}, readPackageVersion}),
    null,
  )
  assert.equal(localAppVersion({env: {CI: "true"}, readPackageVersion}), null)
  assert.equal(
    localAppVersion({
      env: {EXPO_PUBLIC_MENTRAOS_VERSION: "3.4.1"},
      dotenvVersion: "2.8.0",
      readPackageVersion,
    }),
    null,
  )
})

test("rejects a package.json version that is not X.Y.Z", () => {
  assert.throws(() => localAppVersion({env: {}, readPackageVersion: () => "3.4"}), /Invalid package.json version/)
})

test("reads the repository root's package.json", () => {
  assert.match(localAppVersion({env: {}}), /^\d+\.\d+\.\d+$/)
})
