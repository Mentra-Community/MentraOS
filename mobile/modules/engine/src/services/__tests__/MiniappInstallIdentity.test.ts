import {describe, expect, test} from "bun:test"

import {isServedBuildInstalled, miniappInstallIdentityError} from "../miniappInstallIdentity"

describe("managed miniapp install identity", () => {
  const manifest = {packageName: "com.example.remoteassist", version: "1.2.0"}

  test("accepts the exact manifest package and version", () => {
    expect(
      miniappInstallIdentityError(manifest, {
        packageName: "com.example.remoteassist",
        version: "1.2.0",
      }),
    ).toBeNull()
  })

  test("rejects a bundle for a different package", () => {
    expect(miniappInstallIdentityError(manifest, {packageName: "com.example.attacker"})).toContain("package mismatch")
  })

  test("checks the declared version rather than an install-path override", () => {
    expect(miniappInstallIdentityError(manifest, {version: "2.0.0"})).toContain("version mismatch")
  })
})

describe("the update rule: the served build against the installed one", () => {
  const a = "a".repeat(64)
  const b = "b".repeat(64)

  test.each([
    ["the same version", "1.0.0", "1.0.0"],
    ["a higher version", "1.0.0", "1.1.0"],
    ["a lower version", "1.1.0", "1.0.0"],
    ["a prerelease below the installed release", "1.0.0", "1.0.0-beta.2"],
  ])("another hash under %s is another build", (_name, installed, served) => {
    expect(isServedBuildInstalled({version: installed, bundleSha256: a}, {version: served, bundleSha256: b})).toBe(
      false,
    )
  })

  test("the same hash is the installed build, however it is spelled", () => {
    expect(isServedBuildInstalled({version: "1.0.0", bundleSha256: a}, {version: "1.0.0", bundleSha256: a})).toBe(true)
    expect(
      isServedBuildInstalled({version: "1.0.0", bundleSha256: a.toUpperCase()}, {version: "1.0.0", bundleSha256: a}),
    ).toBe(true)
  })

  test("a release with no recorded hash counts as what is served at its version, and as another build at any other", () => {
    expect(isServedBuildInstalled({version: "1.0.0"}, {version: "1.0.0", bundleSha256: b})).toBe(true)
    expect(isServedBuildInstalled({version: "1.0.0"}, {version: "1.1.0", bundleSha256: b})).toBe(false)
    expect(isServedBuildInstalled({version: "1.1.0"}, {version: "1.0.0", bundleSha256: b})).toBe(false)
  })
})
