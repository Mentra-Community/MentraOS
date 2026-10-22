/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"
import type {FleetInstallReason} from "@mentra/cloud-protocol"

mock.module("../../AppRegistry", () => ({default: {}}))

const {createRegistryInventorySource} = await import("../registryInventorySource")
type InventoryRegistry = Parameters<typeof createRegistryInventorySource>[0]

interface FakePackage {
  versions: string[]
  active?: string
  identities: Record<string, {source: string; bundleSha256?: string}>
  reasons: FleetInstallReason[]
}

let loaded = true
let packages: Record<string, FakePackage> = {}
const listeners = new Set<() => void>()
const scans = {count: 0}

const registry: InventoryRegistry = {
  isLoaded: () => loaded,
  getPackageNames: () => {
    scans.count += 1
    return Object.keys(packages)
  },
  getActiveReleaseVersion: (packageName) => {
    const app = packages[packageName]
    const releases = app.versions.filter((version) => !version.startsWith("dev-"))
    if (releases.length === 0) return null
    return app.active && releases.includes(app.active) ? app.active : releases[releases.length - 1]
  },
  getReleaseIdentity: (packageName, version) => packages[packageName]?.identities[version] ?? null,
  getInstallReasons: (packageName) => packages[packageName]?.reasons ?? [],
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

const changed = () => {
  for (const listener of [...listeners]) listener()
}

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)

beforeEach(() => {
  loaded = true
  scans.count = 0
  listeners.clear()
  packages = {
    "com.acme.notes": {
      versions: ["1.0.0", "1.1.0"],
      identities: {"1.0.0": {source: "store", bundleSha256: SHA_A}, "1.1.0": {source: "store", bundleSha256: SHA_B}},
      reasons: ["explicit", "assignment"],
    },
    "com.acme.devonly": {versions: ["dev-1700000000000"], identities: {}, reasons: []},
    "com.mentra.captions": {versions: ["2.0.0"], identities: {"2.0.0": {source: "bundled_asset"}}, reasons: ["bundled"]},
  }
})

describe("the registry inventory source", () => {
  test("lists nothing known until the registry has loaded", () => {
    loaded = false
    expect(createRegistryInventorySource(registry).list()).toBeNull()
    expect(scans.count).toBe(0)
  })

  test("lists each package's active release with its digest and reasons, and leaves development builds out", () => {
    expect(createRegistryInventorySource(registry).list()).toEqual([
      {packageName: "com.acme.notes", versionName: "1.1.0", digest: SHA_B, reasons: ["explicit", "assignment"]},
      // No recorded digest: listed, and the collector leaves it out of the record.
      {packageName: "com.mentra.captions", versionName: "2.0.0", digest: "", reasons: ["bundled"]},
    ])
  })

  test("follows the stored active version, and skips a release recorded as a development snapshot", () => {
    packages["com.acme.notes"].active = "1.0.0"
    packages["com.mentra.captions"].identities["2.0.0"] = {source: "dev_snapshot"}
    expect(createRegistryInventorySource(registry).list()).toEqual([
      {packageName: "com.acme.notes", versionName: "1.0.0", digest: SHA_A, reasons: ["explicit", "assignment"]},
    ])
  })

  test("notifies on every registry change and lists what changed, reading the disk once per change", () => {
    const source = createRegistryInventorySource(registry)
    const listener = mock(() => {})
    const unsubscribe = source.subscribe(listener)

    source.list()
    source.list()
    expect(scans.count).toBe(1)

    packages["com.acme.notes"].reasons = ["explicit"]
    changed()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.list()?.find((app) => app.packageName === "com.acme.notes")?.reasons).toEqual(["explicit"])
    expect(scans.count).toBe(2)

    delete packages["com.mentra.captions"]
    changed()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(source.list()?.map((app) => app.packageName)).toEqual(["com.acme.notes"])

    unsubscribe()
    unsubscribe()
    changed()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listeners.size).toBe(0)
  })

  test("the first load is a change", () => {
    loaded = false
    const source = createRegistryInventorySource(registry)
    const listener = mock(() => {})
    source.subscribe(listener)
    expect(source.list()).toBeNull()
    loaded = true
    changed()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.list()).toHaveLength(2)
  })

  test("a registry that fails to list reads as not known", () => {
    const warn = console.warn
    console.warn = () => {}
    try {
      const source = createRegistryInventorySource({
        ...registry,
        getPackageNames: () => {
          throw new Error("disk unavailable")
        },
      })
      expect(source.list()).toBeNull()
    } finally {
      console.warn = warn
    }
  })
})
