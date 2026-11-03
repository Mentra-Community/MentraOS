import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {configure, resetForTests, type IslandConfigValues} from "../../runtime/bootstrap"
import * as policy from "../SystemMiniappPolicy"
import {isHostTrustedSystemMiniapp, isSystemMiniappPackage} from "../SystemMiniappPolicy"

const store = "com.mentra.store"
const notes = "com.mentra.notes"
const buildConfig: IslandConfigValues = {
  bundledSystemMiniappPackages: [notes, "com.mentra.captions"],
}

function withConfig(config: IslandConfigValues = {}) {
  configure({auth: {}, config: {...buildConfig, ...config}})
}

beforeEach(() => withConfig())
afterEach(resetForTests)

describe("build-owned miniapp identity", () => {
  test("comes from the build's bundled ZIPs, never from a package name pattern", () => {
    expect(isSystemMiniappPackage(notes)).toBe(true)
    expect(isSystemMiniappPackage("com.mentra.unbundled")).toBe(false)
  })

  test("no Store owns or updates a package: the engine updates each from its URL", () => {
    for (const retired of ["automaticUpdateOwner", "isStoreMiniappPackage", "canStoreUpdateSystemMiniapp"]) {
      expect(policy).not.toHaveProperty(retired)
    }
  })

  test("SYSTEM trust follows host provenance", () => {
    expect(isHostTrustedSystemMiniapp(notes, {source: "bundled_asset"})).toBe(true)
    expect(isHostTrustedSystemMiniapp(notes, {source: "direct_download"})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "dev_snapshot"})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "store", storePackageName: store})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, null)).toBe(false)
    expect(isHostTrustedSystemMiniapp("com.mentra.unbundled", {source: "bundled_asset"})).toBe(false)
  })

  test("an organization's pin or exclusion takes a package's SYSTEM trust away", () => {
    withConfig({localMiniappPolicy: {systemPackageNames: ["com.mentra.captions"], managed: []}})
    expect(isHostTrustedSystemMiniapp(notes, {source: "bundled_asset"})).toBe(false)
    withConfig({
      localMiniappPolicy: {
        systemPackageNames: null,
        managed: [{packageName: notes, version: "1.0.0", sha256: "a", deploymentId: "acme", deploymentOrigin: "x"}],
      },
    })
    expect(isHostTrustedSystemMiniapp(notes, {source: "bundled_asset"})).toBe(false)
    withConfig({localMiniappPolicy: {systemPackageNames: null, managed: []}})
    expect(isHostTrustedSystemMiniapp(notes, {source: "bundled_asset"})).toBe(true)
  })
})

describe("updates from Mentra's own host", () => {
  test("a bundled package installed from a Mentra host keeps its system trust", () => {
    withConfig({firstPartyMiniappsUrl: "https://miniapps.mentraglass.com"})
    expect(
      isHostTrustedSystemMiniapp(notes, {
        source: "url",
        sourceUrl: "https://miniapps.mentraglass.com/com.mentra.notes/",
      }),
    ).toBe(true)
    // Including after a deployment that names another host, or none.
    withConfig({firstPartyMiniappsUrl: null})
    expect(
      isHostTrustedSystemMiniapp(notes, {
        source: "url",
        sourceUrl: "https://miniapps.staging.mentraglass.com/com.mentra.notes/",
      }),
    ).toBe(true)
  })

  test("another domain, plain HTTP, or an unbundled package runs without it", () => {
    withConfig({firstPartyMiniappsUrl: "https://miniapps.mentraglass.com/"})
    expect(
      isHostTrustedSystemMiniapp(notes, {source: "url", sourceUrl: "https://evil.example/com.mentra.notes/"}),
    ).toBe(false)
    expect(
      isHostTrustedSystemMiniapp(notes, {
        source: "url",
        sourceUrl: "http://miniapps.mentraglass.com/com.mentra.notes/",
      }),
    ).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "url"})).toBe(false)
    expect(
      isHostTrustedSystemMiniapp("com.mentra.unbundled", {
        source: "url",
        sourceUrl: "https://miniapps.mentraglass.com/com.mentra.unbundled/",
      }),
    ).toBe(false)
  })
})

describe("local-network and development builds", () => {
  test("never run with the build's privileges, whatever bundled package they claim or address they name", () => {
    withConfig({firstPartyMiniappsUrl: "https://miniapps.mentraglass.com/"})
    for (const source of ["local", "dev_snapshot"]) {
      expect(
        isHostTrustedSystemMiniapp(notes, {source, sourceUrl: "https://miniapps.mentraglass.com/com.mentra.notes/"}),
      ).toBe(false)
      expect(isHostTrustedSystemMiniapp(notes, {source, storePackageName: store})).toBe(false)
    }
  })
})

describe("releases the retired Store installed", () => {
  test("keep their trust when the Mentra Store installed them; no other Store's do", () => {
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(true)
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: "com.oem.store"})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store"})).toBe(false)
    expect(isHostTrustedSystemMiniapp("com.mentra.unbundled", {source: "system_store", storePackageName: store})).toBe(
      false,
    )
  })

  test("stay visible to an organization that approves the package", () => {
    withConfig({localMiniappPolicy: {systemPackageNames: null, managed: []}})
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(true)
    withConfig({localMiniappPolicy: {systemPackageNames: [], managed: []}})
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(false)
  })
})
