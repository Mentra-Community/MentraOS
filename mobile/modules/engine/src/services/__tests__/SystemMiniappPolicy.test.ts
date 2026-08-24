/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {
  isHostTrustedSystemMiniapp,
  isPreinstalledMiniappPackageAllowed,
  isStoreMiniappPackage,
  isSystemMiniappPackage,
  requiresConnectedGlasses,
} from "../SystemMiniappPolicy"

describe("SYSTEM miniapp policy", () => {
  test("trusts the bundled Mentra Store", () => {
    expect(isSystemMiniappPackage("com.mentra.store")).toBe(true)
    expect(isSystemMiniappPackage("com.mentra.miniappdev")).toBe(true)
    expect(isStoreMiniappPackage("com.mentra.store")).toBe(true)
    expect(isStoreMiniappPackage("com.mentra.settings")).toBe(false)
  })

  test.each([
    "com.mentra.ai",
    "com.mentra.captions",
    "com.mentra.livestreamer",
    "com.mentra.merge",
    "com.mentra.navigation",
    "com.mentra.notes",
    "com.mentra.recorder",
    "com.mentra.store",
    "com.mentra.teleprompter",
    "com.mentra.translation",
  ])("keeps the currently shipped bundle %s build-owned", (packageName) => {
    expect(isSystemMiniappPackage(packageName)).toBe(true)
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

  test("prevents the remote preinstalled registry from replacing SYSTEM packages", () => {
    expect(isPreinstalledMiniappPackageAllowed("com.mentra.store")).toBe(false)
    expect(isPreinstalledMiniappPackageAllowed("com.mentra.settings")).toBe(false)
    expect(isPreinstalledMiniappPackageAllowed("com.example.weather")).toBe(true)
  })

  test("keeps Store management available while glasses are disconnected", () => {
    expect(requiresConnectedGlasses("com.mentra.store")).toBe(false)
    expect(requiresConnectedGlasses("com.example.weather")).toBe(true)
  })
})
