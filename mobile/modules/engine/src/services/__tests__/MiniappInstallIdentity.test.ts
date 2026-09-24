import {describe, expect, test} from "bun:test"

import {assertMiniappUpdateVersion, miniappInstallIdentityError} from "../miniappInstallIdentity"

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

describe("release version ordering", () => {
  test.each([
    ["1.0.0", []],
    ["1.0.0", ["1.0.0"]],
    ["1.1.0", ["1.0.0"]],
    ["1.0.0", ["1.0.0-beta.1"]],
    ["1.0.0+new", ["1.0.0+old"]],
    ["1.0.0", ["dev-123"]],
    ["dev-456", ["2.0.0"]],
  ] as Array<[string, string[]]>)("accepts %s over %j", (candidate, installed) => {
    expect(() => assertMiniappUpdateVersion("com.example.app", candidate, installed)).not.toThrow()
  })
  test.each([
    ["0.9.0", ["1.0.0"]],
    ["1.0.0-beta.2", ["1.0.0"]],
    ["1.0.0", ["dev-123", "2.0.0", "0.9.0"]],
  ] as Array<[string, string[]]>)("rejects %s below %j", (candidate, installed) => {
    expect(() => assertMiniappUpdateVersion("com.example.app", candidate, installed)).toThrow("already installed")
  })
})
