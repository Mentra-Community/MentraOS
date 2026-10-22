import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {configure, resetForTests, type IslandConfigValues} from "../../runtime/bootstrap"
import {
  automaticUpdateOwner,
  canStoreUpdateSystemMiniapp,
  isHostTrustedSystemMiniapp,
  isStoreMiniappPackage,
  isSystemMiniappPackage,
  requiresConnectedGlasses,
  systemMiniappStoreOwner,
} from "../SystemMiniappPolicy"

const store = "com.mentra.store"
const notes = "com.mentra.notes"
const buildConfig: IslandConfigValues = {
  bundledSystemMiniappPackages: [notes, store, "com.mentra.captions"],
  bundledStoreMiniappPackages: [store],
  bundledSystemMiniappStoreOwners: {[notes]: store, "com.mentra.captions": "com.oem.store"},
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
    expect(isStoreMiniappPackage(store)).toBe(true)
    expect(isStoreMiniappPackage(notes)).toBe(false)
    withConfig({bundledSystemMiniappPackages: [notes]})
    // A Store the build selects must also ship as a bundled ZIP.
    expect(isStoreMiniappPackage(store)).toBe(false)
  })

  test("a Store runs without connected glasses; other miniapps still require them", () => {
    expect(requiresConnectedGlasses(store)).toBe(false)
    expect(requiresConnectedGlasses(notes)).toBe(true)
  })
})

describe("Store ownership of bundled packages", () => {
  test("only the Store the build assigns may update a bundled package", () => {
    expect(canStoreUpdateSystemMiniapp(store, notes)).toBe(true)
    expect(systemMiniappStoreOwner(notes)).toBe(store)
    expect(canStoreUpdateSystemMiniapp("com.oem.store", notes)).toBe(false)
    // Assigned to a Store this build does not ship.
    expect(systemMiniappStoreOwner("com.mentra.captions")).toBeUndefined()
  })

  test("an organization's pin or exclusion takes the package away from the Store", () => {
    withConfig({localMiniappPolicy: {systemPackageNames: [store], managed: []}})
    expect(systemMiniappStoreOwner(notes)).toBeUndefined()
    withConfig({
      localMiniappPolicy: {
        systemPackageNames: null,
        managed: [{packageName: notes, version: "1.0.0", sha256: "a", deploymentId: "acme", deploymentOrigin: "x"}],
      },
    })
    expect(systemMiniappStoreOwner(notes)).toBeUndefined()
    withConfig({localMiniappPolicy: {systemPackageNames: null, managed: []}})
    expect(systemMiniappStoreOwner(notes)).toBe(store)
  })

  test("SYSTEM trust follows host provenance", () => {
    expect(isHostTrustedSystemMiniapp(notes, {source: "bundled_asset"})).toBe(true)
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(true)
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: "com.oem.store"})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "store", storePackageName: store})).toBe(false)
    expect(isHostTrustedSystemMiniapp(notes, {source: "direct_download"})).toBe(false)
    expect(isHostTrustedSystemMiniapp("com.mentra.unbundled", {source: "bundled_asset"})).toBe(false)
  })
})

describe("automatic update owner", () => {
  test.each([
    [notes, {source: "bundled_asset"}, store],
    [notes, {source: "system_store", storePackageName: store}, store],
    [notes, {source: "system_store", storePackageName: "com.oem.store"}, undefined],
    [notes, {source: "direct_download"}, undefined],
    [notes, {source: "dev_snapshot"}, undefined],
    [notes, {source: "deployment_manifest"}, undefined],
    [notes, {source: "store", storePackageName: store}, undefined],
    ["com.acme.weather", {source: "store", storePackageName: store}, store],
    ["com.acme.weather", {source: "store", storePackageName: "com.oem.store"}, "com.oem.store"],
    ["com.acme.weather", {source: "direct_download"}, undefined],
    ["com.acme.weather", null, undefined],
  ])("%s from %j is updated by %s", (packageName, identity, owner) => {
    expect(automaticUpdateOwner(packageName, identity)).toBe(owner)
  })

  test("the bundled Store adopts releases from Core's retired preinstall registry", () => {
    expect(automaticUpdateOwner(notes, {source: "preinstalled_registry"})).toBe(store)
    expect(automaticUpdateOwner("com.acme.weather", {source: "preinstalled_registry"})).toBe(store)
    // That registry only ever served consumer installs.
    withConfig({localMiniappPolicy: {systemPackageNames: null, managed: []}})
    expect(automaticUpdateOwner("com.acme.weather", {source: "preinstalled_registry"})).toBeUndefined()
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

describe("releases the retired Store installed", () => {
  test("keep their trust in a build that bundles no Store", () => {
    withConfig({
      bundledSystemMiniappPackages: [notes],
      bundledStoreMiniappPackages: [],
      bundledSystemMiniappStoreOwners: {},
    })
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(true)
    // Another Store's releases, and the retired Store's install authority, do not carry over.
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: "com.oem.store"})).toBe(false)
    expect(canStoreUpdateSystemMiniapp(store, notes)).toBe(false)
  })

  test("stay visible to an organization that approves the package", () => {
    withConfig({
      bundledSystemMiniappPackages: [notes],
      bundledStoreMiniappPackages: [],
      bundledSystemMiniappStoreOwners: {},
      localMiniappPolicy: {systemPackageNames: null, managed: []},
    })
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(true)
    withConfig({
      bundledSystemMiniappPackages: [notes],
      localMiniappPolicy: {systemPackageNames: [], managed: []},
    })
    expect(isHostTrustedSystemMiniapp(notes, {source: "system_store", storePackageName: store})).toBe(false)
  })
})
