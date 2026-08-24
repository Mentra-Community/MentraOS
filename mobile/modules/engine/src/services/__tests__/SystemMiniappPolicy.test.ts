/// <reference types="bun-types" />

import {afterAll, beforeAll, describe, expect, test} from "bun:test"
import {configure, resetForTests} from "../../runtime/bootstrap"
import {
  canStoreUpdateSystemMiniapp,
  isHostTrustedSystemMiniapp,
  isPreinstalledMiniappPackageAllowed,
  isStoreMiniappPackage,
  isSystemMiniappPackage,
  requiresConnectedGlasses,
} from "../SystemMiniappPolicy"

describe("SYSTEM miniapp policy", () => {
  beforeAll(() => {
    configure({
      auth: {getSubjectToken: async () => ({token: "test", type: "test"})},
      config: {
        bundledSystemMiniappPackages: [
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
        ],
        bundledStoreMiniappPackages: ["com.mentra.store"],
        bundledSystemMiniappStoreOwners: {
          "com.mentra.store": "com.mentra.store",
          "com.mentra.notes": "com.mentra.store",
        },
      },
    })
  })

  afterAll(resetForTests)

  test("trusts the bundled Mentra Store", () => {
    expect(isSystemMiniappPackage("com.mentra.store")).toBe(true)
    expect(isSystemMiniappPackage("com.mentra.miniappdev")).toBe(false)
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

  test("requires trusted provenance in addition to build-owned package identity", () => {
    expect(isHostTrustedSystemMiniapp("com.mentra.store", {source: "bundled_asset"})).toBe(true)
    expect(
      isHostTrustedSystemMiniapp("com.mentra.notes", {
        source: "system_store",
        storePackageName: "com.mentra.store",
      }),
    ).toBe(true)
    expect(isHostTrustedSystemMiniapp("com.mentra.store", {source: "dev_snapshot"})).toBe(false)
    expect(
      isHostTrustedSystemMiniapp("com.mentra.notes", {
        source: "system_store",
        storePackageName: "com.example.store",
      }),
    ).toBe(false)
  })

  test("only the build-selected Store can update a SYSTEM package", () => {
    expect(canStoreUpdateSystemMiniapp("com.mentra.store", "com.mentra.notes")).toBe(true)
    expect(canStoreUpdateSystemMiniapp("com.example.store", "com.mentra.notes")).toBe(false)
    expect(canStoreUpdateSystemMiniapp("com.mentra.store", "com.example.weather")).toBe(false)
  })

  test("prevents the remote preinstalled registry from replacing SYSTEM packages", () => {
    expect(isPreinstalledMiniappPackageAllowed("com.mentra.store")).toBe(false)
    expect(isPreinstalledMiniappPackageAllowed("com.mentra.settings")).toBe(true)
    expect(isPreinstalledMiniappPackageAllowed("com.example.weather")).toBe(true)
  })

  test("keeps Store management available while glasses are disconnected", () => {
    expect(requiresConnectedGlasses("com.mentra.store")).toBe(false)
    expect(requiresConnectedGlasses("com.example.weather")).toBe(true)
  })
})
