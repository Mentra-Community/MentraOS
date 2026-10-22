import {beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import type {MiniappAssignment, MiniappReleaseIdentity} from "../AppRegistry"

const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
let failedWrite: string | undefined
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) => (values.has(key) ? Res.ok(values.get(key)) : Res.error(new Error("Missing key"))),
    save: (key: string, value: unknown) => {
      if (key === failedWrite) return Res.error(new Error("Storage write failed"))
      values.set(key, value)
      return Res.ok(undefined)
    },
    remove: (key: string) => {
      values.delete(key)
      return Res.ok(undefined)
    },
    getAllKeys: () => [...values.keys()],
  },
}))
mock.module("react-native-mmkv", () => ({
  createMMKV: () => ({
    getString: (key: string) => installationValues.get(key),
    set: (key: string, value: string) => installationValues.set(key, value),
    remove: (key: string) => installationValues.delete(key),
  }),
}))
mock.module("../../runtime/bootstrap", () => ({
  assertMiniappDevelopmentAllowed: () => {},
  getConfigValues: () => ({}),
  isDevMiniappAllowed: () => true,
  isInstalledMiniappAllowed: () => true,
  isOfflineSystemMiniappAllowed: () => true,
  isMiniappAvailable: () => true,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))
mock.module("expo/fetch", () => ({fetch: mock()}))
mock.module("expo-file-system", () => ({
  Directory: class {
    exists = false
  },
  File: class {
    exists = false
  },
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
mock.module("react-native-zip-archive", () => ({unzip: mock()}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

const {default: registry, hasAssignmentReason, withReleaseDigest} = await import("../AppRegistry")
const packageName = "com.acme.notes"
const assignment: MiniappAssignment = {
  assignmentId: "asg_1",
  assignmentRevision: 3,
  workspaceId: "ws_A",
  coreUrl: "https://core.mentra.glass",
  mentraUserId: "mu_1",
  url: "https://notes.acme.example/miniapp",
}
let installed: string[] = []

function finalize(version: string, identity: MiniappReleaseIdentity, reason?: "assignment" | "explicit") {
  return registry["finalizeInstall"](
    packageName,
    version,
    identity,
    () => {},
    reason,
    reason === "assignment" ? assignment : undefined,
  )
}

beforeEach(() => {
  values.clear()
  installationValues.clear()
  failedWrite = undefined
  installed = []
  spyOn(registry, "getInstalledVersions").mockImplementation(() => installed)
})

describe("installation reasons", () => {
  test("an assignment install records its reason apart from the release's provenance", () => {
    finalize("1.0.0", {source: "direct_download"}, "assignment").apply()
    installed = ["1.0.0"]

    expect(registry.getInstallReasons(packageName)).toEqual(["assignment"])
    expect(registry.getMiniappAssignment(packageName)).toEqual(assignment)
    expect(hasAssignmentReason(packageName)).toBe(true)
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toEqual({source: "direct_download"})
  })

  test("adding and removing the assignment reason never changes source", () => {
    finalize("1.0.0", {source: "store", storePackageName: "com.mentra.store"}).apply()
    installed = ["1.0.0"]
    const before = registry.getReleaseIdentity(packageName, "1.0.0")

    registry.setMiniappAssignment(packageName, assignment)
    expect(registry.getInstallReasons(packageName)).toEqual(["explicit", "assignment"])
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toEqual(before)

    expect(registry.clearMiniappAssignment(packageName)).toEqual(["explicit"])
    expect(hasAssignmentReason(packageName)).toBe(false)
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toEqual(before)
  })

  test.each([
    ["bundled_asset", "bundled"],
    ["system_store", "bundled"],
    ["preinstalled_registry", "bundled"],
    ["deployment_manifest", "manifest"],
    ["direct_download", "explicit"],
    ["store", "explicit"],
  ] as const)("a package installed before reasons existed, from %s, holds %s", (source, reason) => {
    finalize("1.0.0", {source}).apply()
    installed = ["1.0.0"]
    expect(registry.getInstallReasons(packageName)).toEqual([reason])
    registry.setMiniappAssignment(packageName, assignment)
    expect(registry.clearMiniappAssignment(packageName)).toEqual([reason])
  })

  test("a same-version replacement keeps the reason inferred before its activation hid the release", () => {
    finalize("1.0.0", {source: "system_store"}).apply()
    // While the replacement's pending activation is in place, the release is not a version on disk.
    installed = []
    finalize("1.0.0", {source: "direct_download"}, "assignment").apply()
    installed = ["1.0.0"]
    expect(registry.getInstallReasons(packageName)).toEqual(["bundled", "assignment"])
  })

  test("withdrawing the only reason leaves none, and a later explicit install adds its own", () => {
    finalize("1.0.0", {source: "direct_download"}, "assignment").apply()
    installed = ["1.0.0"]
    expect(registry.clearMiniappAssignment(packageName)).toEqual([])
    finalize("1.1.0", {source: "direct_download"}, "explicit").apply()
    expect(registry.getInstallReasons(packageName)).toEqual(["explicit"])
  })

  test("an install that fails before commit restores the reasons it changed", () => {
    const transaction = finalize("1.0.0", {source: "direct_download"}, "assignment")
    failedWrite = `${packageName}_active_version`
    expect(() => transaction.apply()).toThrow("Storage write failed")
    transaction.rollback()
    expect(registry.getInstallReasons(packageName)).toEqual([])
    expect(hasAssignmentReason(packageName)).toBe(false)
  })

  test("a reason change notifies subscribers; the install transaction's own reason write does not", () => {
    const listener = mock(() => {})
    const unsubscribe = registry.subscribe(listener)
    try {
      finalize("1.0.0", {source: "direct_download"}, "assignment").apply()
      expect(listener).not.toHaveBeenCalled()
      installed = ["1.0.0"]
      registry.clearMiniappAssignment(packageName)
      registry.addInstallReason(packageName, "explicit")
      registry.setMiniappAssignment(packageName, assignment)
      expect(listener).toHaveBeenCalledTimes(3)
    } finally {
      unsubscribe()
    }
  })

  test("the active release is the stored active version when it is a release on disk, else the newest release", () => {
    installed = ["1.0.0", "1.2.0", "dev-1700000000000"]
    expect(registry.getActiveReleaseVersion(packageName)).toBe("1.2.0")
    values.set(`${packageName}_active_version`, "1.0.0")
    expect(registry.getActiveReleaseVersion(packageName)).toBe("1.0.0")
    values.set(`${packageName}_active_version`, "dev-1700000000000")
    expect(registry.getActiveReleaseVersion(packageName)).toBe("1.2.0")
    installed = ["dev-1700000000000"]
    expect(registry.getActiveReleaseVersion(packageName)).toBeNull()
  })

  test("every package holding an assignment reason is listed, whichever account recorded it", () => {
    spyOn(registry, "getPackageNames").mockImplementation(() => [packageName, "com.acme.chat", "com.acme.maps"])
    registry.setMiniappAssignment(packageName, assignment)
    registry.setMiniappAssignment("com.acme.chat", {...assignment, mentraUserId: "mu_2"})
    registry.addInstallReason("com.acme.maps", "explicit")
    expect(registry.getAssignedPackages()).toEqual([packageName, "com.acme.chat"])
  })

  test("an assignment install must name its assignment", async () => {
    await expect(registry["installArchive"](new Uint8Array(), {installReason: "assignment"}, false)).rejects.toThrow(
      "must name its assignment",
    )
  })
})

describe("release digests", () => {
  const bytes = new TextEncoder().encode("abc")
  const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  test("a release without a recorded digest records the SHA-256 of the bytes it installed", async () => {
    expect(await withReleaseDigest({source: "bundled_asset"}, "1.0.0", bytes)).toEqual({
      source: "bundled_asset",
      bundleSha256: ABC_SHA256,
    })
    expect(await withReleaseDigest({source: "direct_download"}, "1.0.0", bytes)).toEqual({
      source: "direct_download",
      bundleSha256: ABC_SHA256,
    })
  })

  test("a caller's verified digest is kept, and a development snapshot records none", async () => {
    const verified = {source: "direct_download" as const, bundleSha256: "f".repeat(64)}
    expect(await withReleaseDigest(verified, "1.0.0", bytes)).toEqual(verified)
    expect(await withReleaseDigest({source: "dev_snapshot"}, "dev-1000", bytes)).toEqual({source: "dev_snapshot"})
  })
})

describe("live-development selection", () => {
  test("a live-development URL is a selection until it is cleared; the installed release then runs", async () => {
    installed = ["1.0.0"]
    expect(registry.hasDevelopmentSelection(packageName)).toBe(false)
    values.set(`${packageName}_dev_url`, "http://192.168.1.20:3000")
    values.set(`${packageName}_dev_port`, 3001)
    values.set(`${packageName}_active_version`, "dev-1000")
    expect(registry.hasDevelopmentSelection(packageName)).toBe(true)

    await registry.clearDevelopmentSelection(packageName)
    expect(registry.hasDevelopmentSelection(packageName)).toBe(false)
    expect(values.has(`${packageName}_dev_port`)).toBe(false)
    expect(values.has(`${packageName}_active_version`)).toBe(false)
    expect(registry.getActiveReleaseVersion(packageName)).toBe("1.0.0")
  })
})

describe("access revocation", () => {
  test("a revoked package's bundle does not resolve, so it cannot launch; nothing is uninstalled", () => {
    spyOn(registry, "getMiniappManifest").mockImplementation(() => null)
    spyOn(registry, "getBundleDir").mockImplementation(() => "file:///test-documents/lmas/com.acme.notes/1.0.0")
    registry.revokeMiniappAccess(packageName)
    expect(registry.isMiniappAccessRevoked(packageName)).toBe(true)
    expect(registry.getMiniappEntryPaths(packageName, "1.0.0")).toBeNull()
    registry.restoreMiniappAccess(packageName)
    expect(registry.getMiniappEntryPaths(packageName, "1.0.0")).not.toBeNull()
  })

  test("uninstalling the last version clears revocation so a later reinstall can launch", async () => {
    registry.revokeMiniappAccess(packageName)
    expect(registry.isMiniappAccessRevoked(packageName)).toBe(true)
    installed = []
    expect((await registry.uninstall(packageName)).is_ok()).toBe(true)
    expect(registry.isMiniappAccessRevoked(packageName)).toBe(false)
  })
})
