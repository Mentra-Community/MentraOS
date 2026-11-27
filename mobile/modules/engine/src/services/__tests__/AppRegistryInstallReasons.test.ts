import {beforeEach, describe, expect, mock, spyOn, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import type {MiniappAssignment, MiniappReleaseIdentity} from "../AppRegistry"

const values = new Map<string, unknown>()
const installationValues = new Map<string, string>()
let failedWrite: string | undefined
let devAllowed = true
/** What each policy check was told besides the release (`isInstalledMiniappAllowed`'s context). */
const policyContexts: unknown[] = []
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
  getConfigValues: () => ({}),
  isDevMiniappAllowed: () => devAllowed,
  isInstalledMiniappAllowed: (_packageName: string, _version: unknown, _identity: unknown, context: unknown) => {
    policyContexts.push(context)
    return true
  },
  isLocalMiniappPackageAllowed: (_packageName: string, context: unknown) => {
    policyContexts.push(context)
    return true
  },
  isOfflineSystemMiniappAllowed: () => true,
  isMiniappAvailable: () => true,
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))
mock.module("expo/fetch", () => ({fetch: mock()}))
/** Directory path to the names of its subdirectories; every other directory does not exist. */
const fakeDirs = new Map<string, string[]>()
const deletedDirs: string[] = []
class FakeDirectory {
  readonly path: string
  readonly name: string
  constructor(...parts: unknown[]) {
    this.path = parts.map(String).join("/")
    this.name = this.path.split("/").at(-1) ?? ""
  }
  get exists(): boolean {
    return fakeDirs.has(this.path)
  }
  list(): FakeDirectory[] {
    return (fakeDirs.get(this.path) ?? []).map((name) => new FakeDirectory(this.path, name))
  }
  delete(): void {
    deletedDirs.push(this.path)
  }
  toString(): string {
    return this.path
  }
}
/** File URIs that exist; every other file does not. */
const existingFiles = new Set<string>()
class FakeFile {
  readonly uri: string
  constructor(...parts: unknown[]) {
    this.uri = parts
      .map(String)
      .join("/")
      .replace(/([^:/])\/{2,}/g, "$1/")
  }
  get exists(): boolean {
    return existingFiles.has(this.uri)
  }
}
mock.module("expo-file-system", () => ({
  Directory: FakeDirectory,
  File: FakeFile,
  Paths: {cache: {list: () => []}, document: "file:///test-documents"},
}))
// Extraction checks each unpacked file's real path through Crust.
mock.module("@mentra/crust", () => ({default: {canonicalFilePath: (path: string) => path}}))
mock.module("react-native-zip-archive", () => ({unzip: mock()}))
mock.module("../../utils/storage/zip", () => ({printDirectory: mock()}))

const {default: registry, hasAssignmentReason, withReleaseDigest} = await import("../AppRegistry")
const partitions = await import("../miniappDataPartition")
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
  existingFiles.clear()
  failedWrite = undefined
  devAllowed = true
  installed = []
  fakeDirs.clear()
  deletedDirs.length = 0
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
    finalize("1.0.0", {source: "url", sourceUrl: "https://notes.example.com/"}).apply()
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

describe("the deployment's policy for an installed release", () => {
  const session = {coreUrl: "https://core.mentra.glass", mentraUserId: "mu_1"}

  test("hears that a package runs as an assignment only while the current workspace assigned it", () => {
    partitions.configureMiniappDataPartitions({
      getSession: () => session,
      assignedWorkspace: () => registry.getMiniappAssignment(packageName)?.workspaceId ?? null,
    })
    try {
      partitions.setFleetWorkspace(session, "ws_A")
      finalize("1.0.0", {source: "url", sourceUrl: "https://notes.acme.example/miniapp/"}, "assignment").apply()
      installed = ["1.0.0"]
      policyContexts.length = 0
      registry.isReleaseAllowed(packageName, "1.0.0")
      partitions.setFleetWorkspace(session, "ws_B")
      registry.isReleaseAllowed(packageName, "1.0.0")
      partitions.setFleetWorkspace(session, "ws_A")
      registry.isPackageAllowed(packageName)
      registry.clearMiniappAssignment(packageName)
      registry.isReleaseAllowed(packageName, "1.0.0")
      registry.isPackageAllowed(packageName)
      expect(policyContexts).toEqual([
        {assigned: true},
        {assigned: false},
        {assigned: true},
        {assigned: false},
        {assigned: false},
      ])

      // Any other provenance is weighed as it always was.
      finalize("1.1.0", {source: "bundled_asset"}, "assignment").apply()
      policyContexts.length = 0
      registry.isReleaseAllowed(packageName, "1.1.0")
      expect(policyContexts).toEqual([{assigned: false}])
    } finally {
      partitions.setFleetWorkspace(session, null)
      partitions.configureMiniappDataPartitions({getSession: () => null, assignedWorkspace: () => null})
    }
  })
})

describe("release digests", () => {
  const bytes = new TextEncoder().encode("abc")
  const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  test("a release without a recorded digest records the SHA-256 of the bytes it installed", async () => {
    expect(await withReleaseDigest({source: "bundled_asset"}, bytes)).toEqual({
      source: "bundled_asset",
      bundleSha256: ABC_SHA256,
    })
    expect(await withReleaseDigest({source: "direct_download"}, bytes)).toEqual({
      source: "direct_download",
      bundleSha256: ABC_SHA256,
    })
    // A development build too, such as an older CLI's release QR, whose server names no hash.
    expect(await withReleaseDigest({source: "local"}, bytes)).toEqual({source: "local", bundleSha256: ABC_SHA256})
  })

  test("a caller's verified digest is kept", async () => {
    const verified = {source: "direct_download" as const, bundleSha256: "f".repeat(64)}
    expect(await withReleaseDigest(verified, bytes)).toEqual(verified)
    const local = {source: "local" as const, sourceUrl: "http://192.168.1.20:3000/", bundleSha256: "e".repeat(64)}
    expect(await withReleaseDigest(local, bytes)).toEqual(local)
  })
})

describe("a development build", () => {
  const packageDir = `file:///test-documents/lmas/${packageName}`
  const local: MiniappReleaseIdentity = {source: "local", sourceUrl: "http://192.168.1.20:3000/"}

  test("is installed while a development build of the package is on disk, whichever runs", async () => {
    installed = ["1.0.0"]
    expect(registry.isDevelopmentBuild(packageName)).toBe(false)
    installed = ["1.0.0", "dev-1000"]
    values.set(`${packageName}_active_version`, "dev-1000")
    expect(registry.isDevelopmentBuild(packageName)).toBe(true)
    expect(await registry.getActiveVersion(packageName)).toBe("dev-1000")
    // Where the deployment doesn't allow development, the release runs; the development build still holds the package.
    devAllowed = false
    expect(await registry.getActiveVersion(packageName)).toBe("1.0.0")
    expect(registry.isDevelopmentBuild(packageName)).toBe(true)
    devAllowed = true
    // Without an active pointer, the development build runs.
    values.delete(`${packageName}_active_version`)
    expect(await registry.getActiveVersion(packageName)).toBe("dev-1000")
  })

  test("is what the Fleet reconciler asks about, and asking changes nothing", () => {
    installed = ["1.0.0", "dev-1000"]
    values.set(`${packageName}_active_version`, "dev-1000")
    expect(registry.isDevelopmentBuild(packageName)).toBe(true)
    expect(values.get(`${packageName}_active_version`)).toBe("dev-1000")
    expect(deletedDirs).toEqual([])
    installed = ["1.0.0"]
    expect(registry.isDevelopmentBuild(packageName)).toBe(false)
  })

  test("is never replaced by a Fleet assignment, a deployment manifest or an automatic update, even at commit", () => {
    installed = ["1.0.0", "dev-1000"]
    values.set(`${packageName}_active_version`, "dev-1000")
    for (const reason of ["assignment", undefined] as const) {
      const install = finalize("2.0.0", {source: "direct_download"}, reason)
      expect(() => install.apply()).toThrow("runs a development build, which only the person replaces")
      install.rollback()
      expect(values.get(`${packageName}_active_version`)).toBe("dev-1000")
    }
    expect(deletedDirs).toEqual([])
  })

  test("is replaced by the person's own release install, which removes it once it commits", async () => {
    installed = ["1.0.0", "dev-1000"]
    fakeDirs.set(packageDir, ["1.0.0", "dev-1000"])
    values.set(`${packageName}_active_version`, "dev-1000")
    const install = finalize("2.0.0", {source: "url", sourceUrl: "https://notes.acme.example/"}, "explicit")
    install.apply()
    expect(values.get(`${packageName}_active_version`)).toBe("2.0.0")
    install.afterCommit?.()
    expect(deletedDirs).toEqual([`${packageDir}/dev-1000`])
  })

  test("installs beside the package's release and its other development builds", () => {
    installed = ["1.0.0", "dev-1000"]
    fakeDirs.set(packageDir, ["1.0.0", "dev-1000"])
    const install = finalize("dev-2000", local)
    install.apply()
    install.afterCommit?.()
    expect(values.get(`${packageName}_active_version`)).toBe("dev-2000")
    expect(registry.getReleaseIdentity(packageName, "dev-2000")).toEqual(local)
    expect(deletedDirs).toEqual([])
  })
})

describe("entry paths", () => {
  const bundleDir = "file:///test-documents/lmas/com.acme.notes/1.0.0/"

  test("hand back the bundle root and the UI entry's path within it, for the package's origin", () => {
    spyOn(registry, "getMiniappManifest").mockImplementation(() => ({
      entry: {background: "background/index.js", ui: "./ui/index.html"},
    }))
    spyOn(registry, "getBundleDir").mockImplementation(() => bundleDir)
    existingFiles.add(`${bundleDir}background/index.js`)
    existingFiles.add(`${bundleDir}ui/index.html`)
    expect(registry.getMiniappEntryPaths(packageName, "1.0.0")).toEqual({
      background: `${bundleDir}background/index.js`,
      ui: `${bundleDir}ui/index.html`,
      rootDir: bundleDir,
      uiPath: "ui/index.html",
    })
  })

  test("a missing UI entry has no path", () => {
    spyOn(registry, "getMiniappManifest").mockImplementation(() => ({
      entry: {background: "background/index.js", ui: "ui/index.html"},
    }))
    spyOn(registry, "getBundleDir").mockImplementation(() => bundleDir)
    existingFiles.add(`${bundleDir}background/index.js`)
    expect(registry.getMiniappEntryPaths(packageName, "1.0.0")).toEqual({
      background: `${bundleDir}background/index.js`,
      ui: null,
      rootDir: bundleDir,
      uiPath: null,
    })
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

describe("uninstalling", () => {
  test("beforeRemove runs inside the uninstall, and refusing keeps the package, its release and its reasons", async () => {
    finalize("1.0.0", {source: "url", sourceUrl: "https://notes.acme.example/"}, "assignment").apply()
    installed = ["1.0.0"]
    fakeDirs.set(`file:///test-documents/lmas/${packageName}`, ["1.0.0"])
    const checked: string[] = []
    const result = await registry.uninstall(packageName, undefined, {
      beforeRemove: () => {
        checked.push(...registry.getInstallReasons(packageName))
        throw new Error("now assigned")
      },
    })
    expect(result.is_error() && result.error.message).toBe("now assigned")
    expect(checked).toEqual(["assignment"])
    expect(deletedDirs).toEqual([])
    expect(registry.getReleaseIdentity(packageName, "1.0.0")).toMatchObject({source: "url"})
    expect(registry.getInstallReasons(packageName)).toEqual(["assignment"])

    expect((await registry.uninstall(packageName, undefined, {beforeRemove: () => {}})).is_ok()).toBe(true)
    expect(deletedDirs).toEqual([`file:///test-documents/lmas/${packageName}`])
  })
})
