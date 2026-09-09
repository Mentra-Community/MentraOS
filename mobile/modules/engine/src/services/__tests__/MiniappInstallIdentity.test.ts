import {describe, expect, test} from "bun:test"

import {miniappInstallIdentityError} from "../miniappInstallIdentity"

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
