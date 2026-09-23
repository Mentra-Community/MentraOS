import {Directory, File, Paths} from "expo-file-system"
import {configure, resetForTests} from "../../../modules/engine/src/runtime/bootstrap"
import {createDevSnapshotRequest} from "../../../modules/engine/src/utils/devSnapshotRequests"
import {runInstallFilesystemTransaction} from "../../../modules/engine/src/services/installOperation"
import {
  isHostTrustedSystemMiniapp,
  canStoreUpdateSystemMiniapp,
} from "../../../modules/engine/src/services/SystemMiniappPolicy"
import {BUNDLED_SYSTEM_MINIAPP_PACKAGES, BUNDLED_SYSTEM_MINIAPP_PUBLISHER_KEYS} from "@/generated/bundledMiniapps"
import {BUNDLED_STORE_MINIAPP_PACKAGES} from "@/constants/miniapps"
import type {ActiveDeployment} from "@/services/deployment/types"
import {createMMKV} from "react-native-mmkv"
import {LogoutUtils} from "@/utils/LogoutUtils"
import {storage} from "@/utils/storage"
import registry, {
  getDevAppRecords,
  registerDevApp,
  unregisterDevApp,
} from "../../../modules/engine/src/services/AppRegistry"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {deploymentStore} from "@/services/deployment/store"
import type {WorkspaceDeployment} from "@/services/deployment/types"
import {deploymentManagedMiniappSync} from "./deploymentManagedMiniappSync"
import {shouldHideMiniapp} from "./miniappVisibility"

let mockDigest = "a".repeat(64)
let mockScript = "verified call"
let mockVersion = "2.1.29"
const mockDownload = jest.fn()
const mockRemoteRead = jest.fn()
const mockUnzip = jest.fn()
const mockMove = jest.fn()
let mockFailNextActiveWrite = false

jest.mock("@/services/MantleManager", () => ({__esModule: true, default: {cleanup: jest.fn(async () => {})}}))
jest.mock("@/services/cloudClient", () => ({
  cloudClient: {
    clearAuthSession: jest.fn(async () => {}),
  },
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {signOut: jest.fn(async () => ({is_error: () => false}))},
}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: jest.fn(async () => {})}))
jest.mock("expo/fetch", () => ({
  fetch: async (url: string) => {
    let read = false
    return {
      ok: true,
      url,
      headers: {get: () => null},
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return {done: true}
            await mockRemoteRead()
            read = true
            return {done: false, value: Uint8Array.from(Buffer.from("archive"))}
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }
  },
}))
jest.mock("react-native-mmkv", () => {
  const stores = new Map<string, Map<string, string>>()
  return {
    createMMKV: ({id = "default"} = {}) => {
      if (!stores.has(id)) stores.set(id, new Map())
      const values = stores.get(id)!
      return {
        getString: (key: string) => values.get(key),
        set: (key: string, value: string) => {
          if (mockFailNextActiveWrite && key.endsWith("_active_version")) {
            mockFailNextActiveWrite = false
            throw new Error("Active version write failed")
          }
          return values.set(key, value)
        },
        remove: (key: string) => values.delete(key),
        clearAll: () => values.clear(),
        getAllKeys: () => [...values.keys()],
      }
    },
  }
})

jest.mock("expo-file-system", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "managed-call-test-"))
  const uri = (parts: Array<string | {uri: string}>) =>
    path.join(...parts.map((p) => (typeof p === "string" ? p : p.uri)))
  class TestFile {
    uri: string
    constructor(...parts: Array<string | {uri: string}>) {
      this.uri = uri(parts)
    }
    get name() {
      return path.basename(this.uri)
    }
    get exists() {
      return fs.existsSync(this.uri)
    }
    get size() {
      return fs.statSync(this.uri).size
    }
    textSync() {
      return fs.readFileSync(this.uri, "utf8")
    }
    async bytes() {
      return Uint8Array.from(this.exists ? fs.readFileSync(this.uri) : Buffer.from("archive"))
    }
    write(value: string) {
      fs.mkdirSync(path.dirname(this.uri), {recursive: true})
      fs.writeFileSync(this.uri, value)
    }
    delete() {
      fs.rmSync(this.uri)
    }
    move(target: TestDirectory) {
      mockMove()
      const dest = path.join(target.uri, this.name)
      fs.renameSync(this.uri, dest)
      this.uri = dest
    }
    static async downloadFileAsync(url: string, target: TestFile) {
      await mockDownload(url)
      target.write("archive")
      return target
    }
  }
  class TestDirectory {
    uri: string
    constructor(...parts: Array<string | {uri: string}>) {
      this.uri = uri(parts)
    }
    get name() {
      return path.basename(this.uri)
    }
    get exists() {
      return fs.existsSync(this.uri)
    }
    create() {
      fs.mkdirSync(this.uri, {recursive: true})
    }
    list() {
      return fs
        .readdirSync(this.uri, {withFileTypes: true})
        .map((entry: {name: string; isDirectory: () => boolean}) =>
          entry.isDirectory() ? new TestDirectory(this.uri, entry.name) : new TestFile(this.uri, entry.name),
        )
    }
    delete() {
      fs.rmSync(this.uri, {recursive: true, force: true})
    }
    move(target: TestDirectory) {
      const dest = target.exists ? path.join(target.uri, this.name) : target.uri
      fs.renameSync(this.uri, dest)
      this.uri = dest
    }
  }
  return {
    File: TestFile,
    Directory: TestDirectory,
    Paths: {document: path.join(root, "documents"), cache: path.join(root, "cache")},
  }
})
jest.mock("react-native-zip-archive", () => ({
  unzip: async (_zip: string, target: string) => {
    await mockUnzip()
    const {File} = require("expo-file-system")
    new File(target, "miniapp.json").write(
      JSON.stringify({packageName: "com.mentra.call", version: mockVersion, entry: {background: "call.js"}}),
    )
    new File(target, "call.js").write(mockScript)
    new File(target, "ui", "index.js").write("verified nested UI")
  },
}))
jest.mock("../../../modules/engine/src/utils/storage/zip", () => ({printDirectory: jest.fn()}))
jest.mock("@mentra/engine-host-internal", () => ({
  appRegistry: jest.requireActual("../../../modules/engine/src/services/AppRegistry").default,
  sha256Hex: async () => mockDigest,
}))
jest.mock("../../../modules/engine/src/utils/sha256", () => ({sha256Hex: async () => mockDigest}))
// Archive validation has its own real-ZIP suite. These native-I/O fixtures
// exercise ownership, byte comparison, activation rollback and cancellation.
jest.mock("../../../modules/engine/src/services/validateInstallBundle", () => ({
  validateInstallBundleArchive: async () => ({packageName: "com.mentra.call", version: mockVersion}),
}))
jest.mock("./miniappZipPreflight", () => ({preflightMiniappZip: jest.fn()}))

const pkg = "com.mentra.call"
const version = "2.1.29"
const consumer = createConsumerDeployment()
const workspace: WorkspaceDeployment = {
  kind: "workspace",
  source: "manual",
  activatedAt: "2026-09-22T00:00:00Z",
  workspaceOrigin: "https://enterprise.example",
  manifestUrl: "https://enterprise.example/.well-known/mentra-deployment.json",
  manifest: {
    ...consumer.manifest,
    deploymentId: "enterprise",
    features: {...consumer.manifest.features, nativeMeetings: true},
    miniapps: {
      configuration: {},
      managed: [
        {packageName: pkg, version, bundleUrl: "https://enterprise.example/miniapps/call.zip", sha256: "a".repeat(64)},
      ],
    },
  },
}
function selectDeployment(deployment: ActiveDeployment) {
  jest.spyOn(deploymentStore, "getActive").mockReturnValue(deployment)
  resetForTests()
  configure({
    auth: {getSubjectToken: async () => ({token: "test", type: "test"})},
    config: {
      bundledSystemMiniappPackages: BUNDLED_SYSTEM_MINIAPP_PACKAGES,
      bundledStoreMiniappPackages: BUNDLED_STORE_MINIAPP_PACKAGES,
      bundledSystemMiniappPublisherKeys: BUNDLED_SYSTEM_MINIAPP_PUBLISHER_KEYS,
      bundledSystemMiniappStoreOwners: Object.fromEntries(
        BUNDLED_SYSTEM_MINIAPP_PACKAGES.map((name) => [name, "com.mentra.store"]),
      ),
      localMiniappPolicy:
        deployment.kind === "workspace"
          ? {
              systemPackageNames: deployment.manifest.systemMiniapps.approvedPackageNamesOverride,
              managed: deployment.manifest.miniapps.managed.map((entry) => ({
                packageName: entry.packageName,
                version: entry.version,
                sha256: entry.sha256,
                deploymentId: deployment.manifest.deploymentId,
                deploymentOrigin: deployment.workspaceOrigin,
              })),
            }
          : undefined,
    },
  })
}

function removeInstalledFixture() {
  new Directory(Paths.document, "lmas", pkg, version).delete()
  registry["removeReleaseIdentity"](pkg, version)
}

const installedScript = () => new File(Paths.document, "lmas", pkg, version, "call.js").textSync()

beforeEach(async () => {
  await deploymentManagedMiniappSync.cancel()
  const fs = require("node:fs")
  for (const dir of [Paths.document, Paths.cache]) fs.rmSync(dir, {recursive: true, force: true})
  mockDownload.mockReset()
  mockRemoteRead.mockReset()
  mockUnzip.mockReset()
  mockMove.mockReset()
  mockFailNextActiveWrite = false
  storage.remove(`${pkg}_workspace_active_version`)
  createMMKV({id: "mentra-miniapp-installations"}).clearAll()
  mockDigest = "a".repeat(64)
  mockScript = "verified call"
  mockVersion = "2.1.29"
  selectDeployment(consumer)
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  selectDeployment(workspace)
})
afterEach(() => jest.restoreAllMocks())
afterAll(() => require("node:fs").rmSync(require("node:path").dirname(Paths.document), {recursive: true, force: true}))

it("adopts an identical verified consumer release and restores consumer installation on workspace exit", async () => {
  storage.save("mentra.account.accessToken", "test-session")
  await LogoutUtils.performCompleteLogout()
  expect(storage.load("mentra.account.accessToken").is_error()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  expect(shouldHideMiniapp(pkg, version)).toBe(true)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(mockDownload).toHaveBeenCalledTimes(1)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  expect(registry.getReleaseIdentity(pkg, version)).toMatchObject({
    source: "deployment_manifest",
    deploymentId: "enterprise",
  })
  expect(installedScript()).toBe("verified call")
  await deploymentManagedMiniappSync.sync(workspace)
  expect(mockDownload).toHaveBeenCalledTimes(1)
  await LogoutUtils.performCompleteLogout()
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
  selectDeployment(consumer)
  await deploymentManagedMiniappSync.sync(consumer)
  expect(registry.getInstalledVersions(pkg)).toEqual([version])
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
})

it.each(["digest", "contents", "extra file"])(
  "isolates consumer files when workspace bundles differ by %s",
  async (failure) => {
    if (failure === "digest") mockDigest = "b".repeat(64)
    if (failure === "contents") mockScript = "different workspace call"
    const extra = new File(Paths.document, "lmas", pkg, version, "extra.js")
    if (failure === "extra file") extra.write("unexpected code")
    await deploymentManagedMiniappSync.sync(workspace)
    expect(shouldHideMiniapp(pkg, version)).toBe(failure === "digest")
    expect(registry.getReleaseIdentity(pkg, version, "consumer")?.source).toBe("bundled_asset")
    expect(installedScript()).toBe("verified call")
    if (failure !== "digest") {
      expect(new File(registry.getBundleDir(pkg, version), "call.js").textSync()).toBe(mockScript)
      expect(new File(registry.getBundleDir(pkg, version), "extra.js").exists).toBe(false)
    }
    mockDigest = "a".repeat(64)
    mockScript = "verified call"
    if (extra.exists) extra.delete()
    await deploymentManagedMiniappSync.sync(workspace)
    expect(shouldHideMiniapp(pkg, version)).toBe(false)
  },
)

it("does not adopt a same-version release owned by another workspace", async () => {
  selectDeployment({
    ...workspace,
    workspaceOrigin: "https://other.example",
    manifest: {...workspace.manifest, deploymentId: "other"},
  })
  expect(
    (
      await registry.installFromLocalZip("foreign.zip", {
        expectedPackageName: pkg,
        expectedVersion: version,
        expectedBundleSha256: "a".repeat(64),
        releaseIdentity: {
          source: "deployment_manifest",
          deploymentId: "other",
          deploymentOrigin: "https://other.example",
          bundleSha256: "a".repeat(64),
        },
      })
    ).is_ok(),
  ).toBe(true)
  selectDeployment(workspace)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(mockDownload).not.toHaveBeenCalled()
  expect(shouldHideMiniapp(pkg, version)).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.deploymentId).toBe("other")
})

it.each(["consumer", "workspace"])(
  "recovers legacy %s files whose ownership was erased by an older logout",
  async (source) => {
    if (source === "workspace") await deploymentManagedMiniappSync.sync(workspace)
    createMMKV({id: "mentra-miniapp-installations"}).remove(
      `miniapp_release_identity:${source === "workspace" ? "workspace:" : ""}${pkg}:${version}`,
    )
    await LogoutUtils.performCompleteLogout()
    expect(registry.getReleaseIdentity(pkg, version)).toBeNull()
    mockDigest = "b".repeat(64)
    await deploymentManagedMiniappSync.sync(workspace)
    expect(registry.getReleaseIdentity(pkg, version)).toBeNull()
    expect(installedScript()).toBe("verified call")
    mockDigest = "a".repeat(64)
    await deploymentManagedMiniappSync.sync(workspace)
    expect(shouldHideMiniapp(pkg, version)).toBe(false)
    await LogoutUtils.performCompleteLogout()
    selectDeployment(consumer)
    await deploymentManagedMiniappSync.sync(consumer)
    expect(registry.getInstalledVersions(pkg)).toEqual([version])
  },
)

it("migrates legacy ownership before the session store is cleared", async () => {
  const key = `miniapp_release_identity:${pkg}:${version}`
  createMMKV({id: "mentra-miniapp-installations"}).remove(key)
  storage.save(key, {source: "bundled_asset"})
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  await LogoutUtils.performCompleteLogout()
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
})

it("adopts a byte-identical consumer registry release after logout", async () => {
  const key = `miniapp_release_identity:${pkg}:${version}`
  createMMKV({id: "mentra-miniapp-installations"}).remove(key)
  storage.save(key, {source: "preinstalled_registry", releaseId: "consumer-release"})
  registry.getReleaseIdentity(pkg, version)
  await LogoutUtils.performCompleteLogout()
  await deploymentManagedMiniappSync.sync(workspace)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
})

it("refreshes cached app metadata when recovering the workspace pin over a newer installed consumer version", async () => {
  await deploymentManagedMiniappSync.sync(workspace)
  mockVersion = "2.1.30"
  selectDeployment(consumer)
  expect((await registry.installFromLocalZip("newer-consumer.zip")).is_ok()).toBe(true)
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe("2.1.30")
  mockVersion = version
  selectDeployment(workspace)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(await registry.getActiveVersion(pkg)).toBe(version)
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(version)
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

it("keeps workspace B's verified Call when A's older download finishes later", async () => {
  removeInstalledFixture()
  const started = deferred()
  const download = deferred()
  mockDownload.mockImplementationOnce(() => {
    started.resolve()
    return download.promise
  })
  const oldSync = deploymentManagedMiniappSync.sync(workspace)
  await started.promise
  const other: WorkspaceDeployment = {
    ...workspace,
    workspaceOrigin: "https://other.example",
    manifest: {...workspace.manifest, deploymentId: "other"},
  }
  selectDeployment(other)
  await deploymentManagedMiniappSync.sync(other)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  expect(registry.getReleaseIdentity(pkg, version)?.deploymentId).toBe("other")
  download.resolve()
  await oldSync
  // Let the cancelled native download finish writing its private cache file.
  await new Promise((resolve) => setImmediate(resolve))
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  expect(new File(registry.getBundleDir(pkg, version), "call.js").textSync()).toBe("verified call")
  expect(JSON.parse(new File(Paths.document, "deployment-managed-miniapps.json").textSync()).deploymentId).toBe("other")
})

it.each(["workspace exit", "logout"])(
  "cancels a download on %s without changing the consumer bundle",
  async (reason) => {
    const started = deferred()
    const download = deferred()
    mockDownload.mockImplementationOnce(() => {
      started.resolve()
      return download.promise
    })
    const oldSync = deploymentManagedMiniappSync.sync(workspace)
    await started.promise
    if (reason === "workspace exit") {
      selectDeployment(consumer)
      await deploymentManagedMiniappSync.sync(consumer)
    } else {
      await deploymentManagedMiniappSync.cancel()
    }
    await oldSync
    download.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
    expect(installedScript()).toBe("verified call")
    expect(new File(Paths.document, "deployment-managed-miniapps.json").exists).toBe(false)
  },
)

it("settles in-flight extraction before workspace exit reconciles ownership", async () => {
  removeInstalledFixture()
  const started = deferred()
  const unzip = deferred()
  mockUnzip.mockImplementationOnce(() => {
    started.resolve()
    return unzip.promise
  })
  const oldSync = deploymentManagedMiniappSync.sync(workspace)
  await started.promise
  selectDeployment(consumer)
  const exit = deploymentManagedMiniappSync.sync(consumer)
  unzip.resolve()
  await Promise.all([oldSync, exit])
  expect(registry.getInstalledVersions(pkg)).toEqual([])
  expect(new File(Paths.document, "deployment-managed-miniapps.json").exists).toBe(false)
})

it("rolls back only its own partially moved bundle and permits a retry", async () => {
  removeInstalledFixture()
  mockMove.mockImplementationOnce(() => {
    throw new Error("disk write failed")
  })
  await deploymentManagedMiniappSync.sync(workspace)
  expect(registry.getInstalledVersions(pkg)).toEqual([])
  await deploymentManagedMiniappSync.sync(workspace)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
})

it("preserves adopted files and consumer ownership when activation metadata fails", async () => {
  const directory = new Directory(Paths.document, "lmas", pkg, version)
  const inode = require("node:fs").statSync(directory.uri).ino
  mockFailNextActiveWrite = true
  await deploymentManagedMiniappSync.sync(workspace)
  expect(installedScript()).toBe("verified call")
  expect(require("node:fs").statSync(directory.uri).ino).toBe(inode)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  expect(new Directory(Paths.document, "lmas", pkg).list().map((entry) => entry.name)).toEqual([version])
  await deploymentManagedMiniappSync.sync(workspace)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
  expect(require("node:fs").statSync(directory.uri).ino).toBe(inode)
})

it("recovers an interrupted adoption's durable metadata without removing its existing files", async () => {
  const key = `miniapp_release_identity:${pkg}:${version}`
  createMMKV({id: "mentra-miniapp-installations"}).set(key, JSON.stringify({source: "deployment_manifest"}))
  const pending = new Directory(Paths.document, "lmas", pkg, `.pending-existing-${version}-1700000000000`)
  pending.create()
  new File(pending, "metadata-rollback.json").write(
    JSON.stringify({
      schemaVersion: 1,
      packageName: pkg,
      version,
      publisher: {present: false},
      release: {present: true, value: {source: "bundled_asset"}},
      active: {present: true, value: version},
    }),
  )
  registry["recoverInterruptedActivations"]()
  expect(installedScript()).toBe("verified call")
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  expect(pending.exists).toBe(false)
})

it("keeps a workspace-adopted first-party bundle unprivileged and rejects Store replacement", async () => {
  expect(BUNDLED_SYSTEM_MINIAPP_PACKAGES).toContain(pkg)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
  expect(isHostTrustedSystemMiniapp(pkg, registry.getReleaseIdentity(pkg, version))).toBe(false)
  expect(canStoreUpdateSystemMiniapp("com.mentra.store", pkg)).toBe(false)
  const replacement = await registry.installFromLocalZip("store.zip", {
    releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
  })
  expect(replacement.is_error()).toBe(true)
  expect(installedScript()).toBe("verified call")
  selectDeployment(consumer)
  await deploymentManagedMiniappSync.sync(consumer)
  expect(registry.getInstalledVersions(pkg)).toEqual([version])
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect((await registry.uninstall(pkg, version)).is_error()).toBe(true)
  expect(isHostTrustedSystemMiniapp(pkg, registry.getReleaseIdentity(pkg, version))).toBe(true)
})

it.each(["Store", "bundled"])("rechecks workspace ownership after a %s install waits in the queue", async (source) => {
  selectDeployment(consumer)
  const entered = deferred()
  const release = deferred()
  const blocked = runInstallFilesystemTransaction(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const install =
    source === "bundled"
      ? registry.installFromLocalZip("consumer.zip")
      : registry.installFromUrl("https://store.example/call.zip", {
          expectedPackageName: pkg,
          expectedVersion: version,
          expectedBundleSha256: "a".repeat(64),
          releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
        })
  // Drain the mock download/validation, leaving activation behind the held queue.
  await new Promise((resolve) => setImmediate(resolve))
  selectDeployment(workspace)
  release.resolve()
  await blocked
  expect((await install).is_error()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  await deploymentManagedMiniappSync.sync(workspace)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
})

it.each(["Store", "bundled"])(
  "preserves the consumer bundle when workspace selection changes during %s extraction",
  async (source) => {
    selectDeployment(consumer)
    const entered = deferred()
    const release = deferred()
    mockUnzip.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    mockScript = "late Store replacement"
    const install =
      source === "bundled"
        ? registry.installFromLocalZip("consumer.zip")
        : registry.installFromUrl("https://store.example/call.zip", {
            expectedPackageName: pkg,
            expectedVersion: version,
            expectedBundleSha256: "a".repeat(64),
            releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
          })
    await entered.promise
    selectDeployment(workspace)
    release.resolve()
    expect((await install).is_error()).toBe(true)
    expect(installedScript()).toBe("verified call")
    mockScript = "verified call"
    await deploymentManagedMiniappSync.sync(workspace)
    expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
  },
)

it.each(["inside workspace", "before entering workspace"])(
  "keeps a Store update visible when installed %s and the package is approved without a pin",
  async (when) => {
    const unpinned: WorkspaceDeployment = {
      ...workspace,
      manifest: {
        ...workspace.manifest,
        miniapps: {configuration: {}, managed: []},
        systemMiniapps: {approvedPackageNamesOverride: [pkg]},
      },
    }
    selectDeployment(unpinned)
    expect(await registry.getActiveVersion(pkg)).toBe(version)
    selectDeployment(when === "inside workspace" ? unpinned : consumer)
    mockVersion = "2.1.30"
    expect(
      (
        await registry.installFromUrl("https://store.example/call.zip", {
          releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
        })
      ).is_ok(),
    ).toBe(true)
    selectDeployment(unpinned)
    await deploymentManagedMiniappSync.sync(unpinned)
    expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe("2.1.30")
    expect(isHostTrustedSystemMiniapp(pkg, registry.getReleaseIdentity(pkg, "2.1.30"))).toBe(true)
    // A later workspace pin still takes precedence over the consumer update.
    mockVersion = version
    selectDeployment(workspace)
    await deploymentManagedMiniappSync.sync(workspace)
    expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(version)
  },
)

it("allows QR dev overrides and snapshots of bundled packages without privileged identity", async () => {
  selectDeployment(consumer)
  await registerDevApp({packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""})
  expect(getDevAppRecords().some((app) => app.packageName === pkg)).toBe(true)
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.devUrl).toBe(
    "http://localhost:8081",
  )
  expect(
    (
      await registry.installFromUrl("http://localhost:8081/bundle.zip", {
        expectedPackageName: pkg,
        versionOverride: "dev-123",
        releaseIdentity: {source: "dev_snapshot"},
      })
    ).is_ok(),
  ).toBe(true)
  expect(registry.hasDevSnapshot(pkg)).toBe(true)
  expect(isHostTrustedSystemMiniapp(pkg, registry.getReleaseIdentity(pkg, "dev-123"))).toBe(false)
  selectDeployment(workspace)
  expect(getDevAppRecords()).toEqual([])
  await expect(
    registerDevApp({packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""}),
  ).rejects.toThrow("workspace")
  selectDeployment(consumer)
  expect(getDevAppRecords().some((app) => app.packageName === pkg)).toBe(true)
  unregisterDevApp(pkg)
})

it("installs unsigned manual replacements under the same bundled package identity", async () => {
  selectDeployment(consumer)
  mockVersion = "2.1.30"
  expect(
    (
      await registry.installFromUrl("https://manual.example/call.zip", {
        expectedPackageName: pkg,
        expectedVersion: mockVersion,
      })
    ).is_ok(),
  ).toBe(true)
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(mockVersion)
  expect(registry.getReleaseIdentity(pkg, mockVersion)?.source).toBe("direct_download")
  expect(isHostTrustedSystemMiniapp(pkg, registry.getReleaseIdentity(pkg, mockVersion))).toBe(false)
})

it.each([
  ["manual", false],
  ["manual", true],
  ["dev", false],
  ["dev", true],
])("selects an approved bundled copy over a %s override (bundle needs reinstall=%s)", async (kind, reinstall) => {
  selectDeployment(consumer)
  const override = kind === "dev" ? "dev-999" : "2.1.30"
  if (kind === "dev") {
    await registerDevApp({packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""})
  }
  mockVersion = "2.1.30"
  expect(
    (
      await registry.installFromUrl("http://localhost:8081/bundle.zip", {
        versionOverride: override,
        releaseIdentity: {source: kind === "dev" ? "dev_snapshot" : "direct_download"},
      })
    ).is_ok(),
  ).toBe(true)
  await registry.getInstalledMiniapps() // cache the consumer projection before switching
  if (reinstall) removeInstalledFixture()
  const unpinned: WorkspaceDeployment = {
    ...workspace,
    manifest: {
      ...workspace.manifest,
      miniapps: {configuration: {}, managed: []},
      systemMiniapps: {approvedPackageNamesOverride: [pkg]},
    },
  }
  selectDeployment(unpinned)
  if (reinstall) {
    mockVersion = version
    expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  }
  for (let startup = 0; startup < 2; startup++) {
    selectDeployment(unpinned)
    registry.markRefreshNeeded()
    expect(await registry.getActiveVersion(pkg)).toBe(version)
    expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(version)
    expect(getDevAppRecords()).toEqual([])
    expect(new File(Paths.document, "lmas", pkg, override, "call.js").exists).toBe(true)
  }
  selectDeployment(consumer)
  expect(await registry.getActiveVersion(pkg)).toBe(override)
  const restored = (await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)
  if (kind === "dev") expect(restored?.devUrl).toBe("http://localhost:8081")
  else expect(restored?.version).toBe(override)
})

it("preserves a consumer manual release through workspace Store updates and release cleanup", async () => {
  selectDeployment(consumer)
  mockVersion = "2.1.30"
  expect((await registry.installFromUrl("https://manual.example/bundle.zip")).is_ok()).toBe(true)
  const unpinned: WorkspaceDeployment = {
    ...workspace,
    manifest: {
      ...workspace.manifest,
      miniapps: {configuration: {}, managed: []},
      systemMiniapps: {approvedPackageNamesOverride: [pkg]},
    },
  }
  selectDeployment(unpinned)
  expect(await registry.getActiveVersion(pkg)).toBe(version)
  mockVersion = "2.1.31"
  expect(
    (
      await registry.installFromUrl("https://store.example/bundle.zip", {
        releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
      })
    ).is_ok(),
  ).toBe(true)
  registry.gcReleaseVersions(pkg, [version, mockVersion])
  expect(await registry.getActiveVersion(pkg)).toBe("2.1.31")
  selectDeployment(consumer)
  expect(await registry.getActiveVersion(pkg)).toBe("2.1.30")
  expect(new File(Paths.document, "lmas", pkg, "2.1.30", "call.js").exists).toBe(true)
})

it("preserves consumer dev routing when entering and leaving an exact managed pin", async () => {
  selectDeployment(consumer)
  await registerDevApp({packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""})
  expect(
    (
      await registry.installFromUrl("http://localhost:8081/bundle.zip", {
        versionOverride: "dev-999",
        releaseIdentity: {source: "dev_snapshot"},
      })
    ).is_ok(),
  ).toBe(true)
  selectDeployment(workspace)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(await registry.getActiveVersion(pkg)).toBe(version)
  expect(getDevAppRecords()).toEqual([])
  selectDeployment(consumer)
  await deploymentManagedMiniappSync.sync(consumer)
  expect(await registry.getActiveVersion(pkg)).toBe("dev-999")
  expect(getDevAppRecords().find((app) => app.packageName === pkg)?.devUrl).toBe("http://localhost:8081")
})

it("recovers a workspace selection journal without changing the consumer selection", async () => {
  storage.save(`${pkg}_active_version`, "2.1.30")
  storage.save(`${pkg}_workspace_active_version`, "2.1.31")
  const pending = new Directory(Paths.document, "lmas", pkg, `.pending-existing-${version}-1700000000000`)
  pending.create()
  new File(pending, "metadata-rollback.json").write(
    JSON.stringify({
      schemaVersion: 1,
      packageName: pkg,
      version,
      workspaceSelection: true,
      publisher: {present: false},
      release: {present: true, value: {source: "bundled_asset"}},
      active: {present: true, value: version},
    }),
  )
  selectDeployment(consumer) // recovery can happen after switching environments
  registry["recoverInterruptedActivations"]()
  const consumerSelection = storage.load<string>(`${pkg}_active_version`)
  const workspaceSelection = storage.load<string>(`${pkg}_workspace_active_version`)
  expect(consumerSelection.is_ok() && consumerSelection.value).toBe("2.1.30")
  expect(workspaceSelection.is_ok() && workspaceSelection.value).toBe(version)
})

it.each(["bundled", "managed", "Store"])(
  "retains different consumer bytes when a workspace installs the same version from %s",
  async (source) => {
    selectDeployment(consumer)
    mockVersion = "2.1.30"
    mockScript = "consumer customized build"
    expect((await registry.installFromUrl("https://manual.example/bundle.zip")).is_ok()).toBe(true)
    const consumerPath = registry.getBundleDir(pkg, mockVersion)
    const selectedWorkspace: WorkspaceDeployment = {
      ...workspace,
      manifest: {
        ...workspace.manifest,
        systemMiniapps: {approvedPackageNamesOverride: [pkg]},
        miniapps: {
          configuration: {},
          managed: source === "managed" ? [{...workspace.manifest.miniapps.managed[0], version: mockVersion}] : [],
        },
      },
    }
    // A later host update can ship the same semantic version as the manual build.
    selectDeployment(selectedWorkspace)
    mockScript = "workspace official build"
    if (source === "managed") await deploymentManagedMiniappSync.sync(selectedWorkspace)
    else if (source === "Store") {
      expect(
        (
          await registry.installFromUrl("https://store.example/bundle.zip", {
            releaseIdentity: {source: "system_store", storePackageName: "com.mentra.store"},
          })
        ).is_ok(),
      ).toBe(true)
    } else expect((await registry.installFromLocalZip("host-upgrade.zip")).is_ok()).toBe(true)

    const workspacePath = registry.getBundleDir(pkg, mockVersion)
    expect(workspacePath).not.toBe(consumerPath)
    expect(new File(workspacePath, "call.js").textSync()).toBe("workspace official build")
    expect(new File(consumerPath, "call.js").textSync()).toBe("consumer customized build")
    expect(registry.getReleaseIdentity(pkg, mockVersion, "consumer")?.source).toBe("direct_download")
    const workspaceIdentity = registry.getReleaseIdentity(pkg, mockVersion)
    registry["recoverInterruptedActivations"]()
    registry.markRefreshNeeded()
    selectDeployment(selectedWorkspace)
    expect(await registry.getActiveVersion(pkg)).toBe(mockVersion)
    expect(registry.getBundleDir(pkg, mockVersion)).toBe(workspacePath)
    expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(mockVersion)
    expect(registry.getReleaseIdentity(pkg, mockVersion)).toEqual(workspaceIdentity)

    selectDeployment(consumer)
    await deploymentManagedMiniappSync.sync(consumer)
    expect(await registry.getActiveVersion(pkg)).toBe(mockVersion)
    expect(registry.getBundleDir(pkg, mockVersion)).toBe(consumerPath)
    expect(new File(registry.getMiniappEntryPaths(pkg, mockVersion)!.background!).textSync()).toBe(
      "consumer customized build",
    )
    expect(registry.getReleaseIdentity(pkg, mockVersion)?.source).toBe("direct_download")
  },
)

it("does not expose an uncommitted workspace copy through a consumer version with the same name", async () => {
  selectDeployment(workspace)
  await deploymentManagedMiniappSync.sync(workspace)
  const pending = new Directory(Paths.document, "lmas-workspace", pkg, `.pending-existing-${version}-1700000000000`)
  pending.create()
  registry.markRefreshNeeded()
  expect(registry.getInstalledVersions(pkg, "workspace")).toEqual([])
  expect((await registry.getInstalledMiniapps()).some((app) => app.packageName === pkg)).toBe(false)
  pending.delete()
  registry.markRefreshNeeded()
  expect((await registry.getInstalledMiniapps()).some((app) => app.packageName === pkg)).toBe(true)
})

it("recovers workspace bytes and provenance after switching back to consumer mode", async () => {
  selectDeployment(consumer)
  mockVersion = "2.1.30"
  mockScript = "consumer customized build"
  expect((await registry.installFromUrl("https://manual.example/bundle.zip")).is_ok()).toBe(true)
  const unpinned: WorkspaceDeployment = {
    ...workspace,
    manifest: {
      ...workspace.manifest,
      miniapps: {configuration: {}, managed: []},
      systemMiniapps: {approvedPackageNamesOverride: [pkg]},
    },
  }
  selectDeployment(unpinned)
  mockScript = "original workspace build"
  expect((await registry.installFromLocalZip("official.zip")).is_ok()).toBe(true)
  const packageDir = new Directory(Paths.document, "lmas-workspace", pkg)
  const installed = new Directory(packageDir, mockVersion)
  installed.move(new Directory(packageDir, `.backup-${mockVersion}-1700000000000`))
  new Directory(packageDir, mockVersion).create()
  new File(packageDir, mockVersion, "call.js").write("interrupted replacement")
  const pending = new Directory(packageDir, `.pending-existing-${mockVersion}-1700000000000`)
  pending.create()
  new File(pending, "metadata-rollback.json").write(
    JSON.stringify({
      schemaVersion: 1,
      packageName: pkg,
      version: mockVersion,
      storageScope: "workspace",
      workspaceSelection: true,
      publisher: {present: false},
      release: {present: true, value: {source: "bundled_asset"}},
      active: {present: true, value: mockVersion},
    }),
  )
  createMMKV({id: "mentra-miniapp-installations"}).set(
    `miniapp_release_identity:workspace:${pkg}:${mockVersion}`,
    JSON.stringify({source: "deployment_manifest"}),
  )
  selectDeployment(consumer)
  registry["recoverInterruptedActivations"]()
  expect(new File(packageDir, mockVersion, "call.js").textSync()).toBe("original workspace build")
  expect(registry.getReleaseIdentity(pkg, mockVersion, "workspace")?.source).toBe("bundled_asset")
  expect(new File(registry.getBundleDir(pkg, mockVersion), "call.js").textSync()).toBe("consumer customized build")
  expect(registry.getReleaseIdentity(pkg, mockVersion)?.source).toBe("direct_download")
  expect(pending.exists).toBe(false)
})

it("migrates legacy workspace-owned files without removing an independent consumer override", async () => {
  createMMKV({id: "mentra-miniapp-installations"}).set(
    `miniapp_release_identity:${pkg}:${version}`,
    JSON.stringify({
      source: "deployment_manifest",
      deploymentId: workspace.manifest.deploymentId,
      deploymentOrigin: workspace.workspaceOrigin,
      bundleSha256: "a".repeat(64),
    }),
  )
  selectDeployment(consumer)
  mockVersion = "2.1.30"
  mockScript = "consumer customized build"
  expect((await registry.installFromUrl("https://manual.example/bundle.zip")).is_ok()).toBe(true)
  selectDeployment(workspace)
  mockVersion = version
  mockScript = "workspace build"
  await deploymentManagedMiniappSync.sync(workspace)
  expect(new File(Paths.document, "lmas", pkg, version, "call.js").exists).toBe(false)
  expect(new File(registry.getBundleDir(pkg, version), "call.js").textSync()).toBe("workspace build")
  selectDeployment(consumer)
  await deploymentManagedMiniappSync.sync(consumer)
  expect(await registry.getActiveVersion(pkg)).toBe("2.1.30")
  expect(new File(registry.getBundleDir(pkg, "2.1.30"), "call.js").textSync()).toBe("consumer customized build")
  expect(registry.getDeploymentOwnedReleases()).toEqual([])
})

it("rejects same-version manual archive replacement without changing files or provenance", async () => {
  selectDeployment(consumer)
  mockScript = "broken same-version replacement"
  const result = await registry.installFromUrl("https://manual.example/call.zip", {
    expectedPackageName: pkg,
    expectedVersion: version,
    rejectExistingVersion: true,
  })
  expect(result.is_error()).toBe(true)
  expect(installedScript()).toBe("verified call")
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
  expect(await registry.getActiveVersion(pkg)).toBe(version)
})

it("retains a developer snapshot for manual runtime recovery until explicit cleanup", async () => {
  selectDeployment(consumer)
  await registerDevApp({packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""})
  expect(
    (
      await registry.installFromUrl("http://localhost:8081/bundle.zip", {
        expectedPackageName: pkg,
        versionOverride: "dev-123",
        releaseIdentity: {source: "dev_snapshot"},
      })
    ).is_ok(),
  ).toBe(true)
  mockVersion = "2.1.30"
  expect(
    (
      await registry.installFromUrl("https://manual.example/call.zip", {
        expectedPackageName: pkg,
        expectedVersion: mockVersion,
        rejectExistingVersion: true,
        preserveDevSnapshots: true,
      })
    ).is_ok(),
  ).toBe(true)
  expect(getDevAppRecords()).toEqual([])
  expect(registry.hasDevSnapshot(pkg)).toBe(true)
  expect(new File(Paths.document, "lmas", pkg, "dev-123", "call.js").textSync()).toBe("verified call")
  registry.gcDevVersions(pkg, 0)
  expect(registry.hasDevSnapshot(pkg)).toBe(false)
  expect(registry.getReleaseIdentity(pkg, "dev-123")).toBeNull()
})

it("prevents an earlier dev download from changing the active release after manual installation", async () => {
  selectDeployment(consumer)
  const entered = deferred()
  const release = deferred()
  const request = createDevSnapshotRequest(pkg)
  mockRemoteRead.mockImplementationOnce(() => {
    entered.resolve()
    return release.promise
  })
  const snapshot = registry.installFromUrl("http://localhost:8081/bundle.zip", {
    expectedPackageName: pkg,
    versionOverride: "dev-456",
    releaseIdentity: {source: "dev_snapshot"},
    beforeActivate: request.beforeActivate,
  })
  await entered.promise
  mockVersion = "2.1.30"
  expect(
    (
      await registry.installFromUrl("https://manual.example/call.zip", {
        expectedPackageName: pkg,
        expectedVersion: mockVersion,
        rejectExistingVersion: true,
      })
    ).is_ok(),
  ).toBe(true)
  mockVersion = version
  release.resolve()
  expect((await snapshot).is_error()).toBe(true)
  expect(await registry.getActiveVersion(pkg)).toBe("2.1.30")
  expect(registry.getReleaseIdentity(pkg, "2.1.30")?.source).toBe("direct_download")
  expect(registry.hasDevSnapshot(pkg)).toBe(false)
})

it("keeps an unavailable bundled release installed while excluding it from registry discovery", async () => {
  selectDeployment(consumer)
  const config = require("../../../modules/engine/src/runtime/bootstrap").getConfigValues()
  let available = false
  configure({auth: {}, config: {...config, isMiniappAvailable: () => available}})
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)).toBeUndefined()
  expect(registry.getInstalledVersions(pkg)).toContain(version)
  available = true
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe(version)
})
