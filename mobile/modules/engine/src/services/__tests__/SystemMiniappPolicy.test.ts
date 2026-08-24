/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {isHostTrustedSystemMiniapp, isSystemMiniappPackage} from "../SystemMiniappPolicy"

describe("SYSTEM miniapp policy", () => {
  test("trusts the bundled Mentra Store", () => {
    expect(isSystemMiniappPackage("com.mentra.store")).toBe(true)
  })

  test.each(["com.example.store", "com.mentra.store.fake", "com.example.dev"])(
    "does not grant SYSTEM to author-controlled package %s",
    (packageName) => expect(isSystemMiniappPackage(packageName)).toBe(false),
  )

  test("requires host-bundled provenance in addition to the package allowlist", () => {
    expect(isHostTrustedSystemMiniapp("com.mentra.store", "bundled_asset")).toBe(true)
    expect(isHostTrustedSystemMiniapp("com.mentra.store", "dev_snapshot")).toBe(false)
    expect(isHostTrustedSystemMiniapp("com.mentra.store", "store")).toBe(false)
  })
})
