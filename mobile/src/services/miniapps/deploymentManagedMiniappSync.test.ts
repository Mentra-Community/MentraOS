import {Directory, File, Paths} from "expo-file-system"
import {engine, SETTINGS} from "@mentra/engine"
import {createMMKV} from "react-native-mmkv"
import {LogoutUtils} from "@/utils/LogoutUtils"
import {storage} from "@/utils/storage"
import {configure, resetForTests} from "../../../modules/engine/src/runtime/bootstrap"
import registry, {
  assertDevBuildAllowed,
  getDevAppRecords,
  registerDevApp,
  SignedMiniappDevBuildError,
  type InstallBundleOptions,
} from "../../../modules/engine/src/services/AppRegistry"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment, WorkspaceDeployment} from "@/services/deployment/types"
import {deploymentManagedMiniappSync} from "./deploymentManagedMiniappSync"
import {shouldHideMiniapp} from "./miniappVisibility"

let mockDigest = "a".repeat(64)
let mockScript = "verified call"
let mockVersion = "2.1.29"
let mockPublisherFingerprint: string | undefined
const mockValidatedArchives: string[] = []
let mockFailNextActiveWrite = false
const mockDownload = jest.fn()
const mockRemoteRead = jest.fn()
const mockUnzip = jest.fn()
const mockMove = jest.fn()
const mockGetPreinstalledRegistry = jest.fn()

jest.mock("@/services/MantleManager", () => ({__esModule: true, default: {cleanup: jest.fn(async () => {})}}))
jest.mock("@/services/cloudClient", () => ({
  cloudClient: {
    clearAuthSession: jest.fn(async () => {}),
    getPreinstalledMiniappRegistry: (...args: unknown[]) => mockGetPreinstalledRegistry(...args),
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
    // expo-file-system semantics: move into an existing directory, else rename to it.
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
  unzip: async (zip: string, target: string) => {
    await mockUnzip(zip)
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
}))
jest.mock("./preinstalledMiniappSync", () => ({sha256Hex: async () => mockDigest}))
// Archive validation has its own real-ZIP suite. These native-I/O fixtures
// exercise ownership, byte comparison, the version and signer rules,
// activation rollback and cancellation.
jest.mock("../../../modules/engine/src/services/validateInstallBundle", () => ({
  validateInstallBundleArchive: async (bytes: Uint8Array) => {
    mockValidatedArchives.push(Buffer.from(bytes).toString("utf8"))
    return {
      packageName: "com.mentra.call",
      version: mockVersion,
      hardwareRequirements: [],
      ...(mockPublisherFingerprint ? {publisherKeyFingerprint: mockPublisherFingerprint} : {}),
    }
  },
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
const installedScript = () => new File(Paths.document, "lmas", pkg, version, "call.js").textSync()

/** Select a deployment for the host and give the engine the policy the host would. */
function selectDeployment(deployment: ActiveDeployment) {
  jest.spyOn(deploymentStore, "getActive").mockReturnValue(deployment)
  resetForTests()
  configure({
    auth: {getSubjectToken: async () => ({token: "test", type: "test"})},
    config: {
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

beforeEach(async () => {
  await deploymentManagedMiniappSync.cancel()
  const fs = require("node:fs")
  for (const dir of [Paths.document, Paths.cache]) fs.rmSync(dir, {recursive: true, force: true})
  // Installed bundles and their durable metadata start empty for every test.
  createMMKV({id: "mentra-miniapp-installations"}).clearAll()
  mockDownload.mockReset()
  mockRemoteRead.mockReset()
  mockUnzip.mockReset()
  mockMove.mockReset()
  mockGetPreinstalledRegistry.mockReset()
  mockDigest = "a".repeat(64)
  mockScript = "verified call"
  mockVersion = "2.1.29"
  mockPublisherFingerprint = undefined
  mockFailNextActiveWrite = false
  mockValidatedArchives.length = 0
  selectDeployment(workspace)
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
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
  expect(registry.getInstalledVersions(pkg)).toEqual([])
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
})

it.each(["digest", "contents", "extra file"])(
  "preserves consumer files on %s mismatch and permits a verified retry",
  async (failure) => {
    if (failure === "digest") mockDigest = "b".repeat(64)
    if (failure === "contents") mockScript = "different workspace call"
    const extra = new File(Paths.document, "lmas", pkg, version, "extra.js")
    if (failure === "extra file") extra.write("unexpected code")
    await deploymentManagedMiniappSync.sync(workspace)
    expect(shouldHideMiniapp(pkg, version)).toBe(true)
    expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
    expect(installedScript()).toBe("verified call")
    mockDigest = "a".repeat(64)
    mockScript = "verified call"
    if (extra.exists) extra.delete()
    await deploymentManagedMiniappSync.sync(workspace)
    expect(shouldHideMiniapp(pkg, version)).toBe(false)
  },
)

it("does not adopt a same-version release owned by another workspace", async () => {
  await registry.installFromLocalZip("foreign.zip", {
    releaseIdentity: {
      source: "deployment_manifest",
      deploymentId: "other",
      deploymentOrigin: "https://other.example",
      bundleSha256: "a".repeat(64),
    },
  })
  await deploymentManagedMiniappSync.sync(workspace)
  expect(mockDownload).not.toHaveBeenCalled()
  expect(shouldHideMiniapp(pkg, version)).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.deploymentId).toBe("other")
})

it.each(["consumer", "workspace"])(
  "recovers legacy %s files whose ownership was erased by an older logout",
  async (source) => {
    if (source === "workspace") await deploymentManagedMiniappSync.sync(workspace)
    createMMKV({id: "mentra-miniapp-installations"}).remove(`miniapp_release_identity:${pkg}:${version}`)
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
    expect(registry.getInstalledVersions(pkg)).toEqual([])
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
  await registry.installFromLocalZip("consumer-registry.zip", {
    releaseIdentity: {source: "preinstalled_registry", releaseId: "consumer-release"},
  })
  await LogoutUtils.performCompleteLogout()
  await deploymentManagedMiniappSync.sync(workspace)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("deployment_manifest")
})

it("refreshes cached app metadata when recovering the workspace pin over a newer installed consumer version", async () => {
  await deploymentManagedMiniappSync.sync(workspace)
  mockVersion = "2.1.30"
  expect((await registry.installFromLocalZip("newer-consumer.zip")).is_ok()).toBe(true)
  expect((await registry.getInstalledMiniapps()).find((app) => app.packageName === pkg)?.version).toBe("2.1.30")
  mockVersion = version
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
  await registry.uninstall(pkg, version)
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
  expect(installedScript()).toBe("verified call")
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

it("finishes and records an in-flight unzip before workspace exit cleans its ownership", async () => {
  await registry.uninstall(pkg, version)
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
  await registry.uninstall(pkg, version)
  mockMove.mockImplementationOnce(() => {
    throw new Error("disk write failed")
  })
  await deploymentManagedMiniappSync.sync(workspace)
  expect(registry.getInstalledVersions(pkg)).toEqual([])
  await deploymentManagedMiniappSync.sync(workspace)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
})

it("does not let a late consumer registry download overwrite a verified workspace release", async () => {
  await registry.uninstall(pkg, version)
  const started = deferred()
  const download = deferred()
  mockDownload.mockImplementationOnce(() => {
    started.resolve()
    return download.promise
  })
  const consumerSync = jest.requireActual<typeof import("./preinstalledMiniappSync")>("./preinstalledMiniappSync")
  mockGetPreinstalledRegistry.mockResolvedValue({
    entries: [
      {
        packageName: pkg,
        version,
        bundleUrl: "https://consumer.example/call.zip",
        bundleSha256: require("node:crypto").createHash("sha256").update("archive").digest("hex"),
        channel: "dev",
        installPolicy: "keep_updated",
      },
    ],
  })
  selectDeployment(consumer)
  const oldSync = consumerSync.preinstalledMiniappSync.sync()
  await started.promise
  selectDeployment(workspace)
  await deploymentManagedMiniappSync.sync(workspace)
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
  download.resolve()
  await oldSync
  expect(registry.getReleaseIdentity(pkg, version)?.deploymentId).toBe("enterprise")
  expect(shouldHideMiniapp(pkg, version)).toBe(false)
})

describe("one installer for every install source", () => {
  type Source = "manual" | "bundled" | "dev snapshot"
  const devRecord = {packageName: pkg, name: "Local Call", devUrl: "http://localhost:8081", iconUrl: ""}

  /** The entry points QR/manual, bundled and dev snapshot installs use. */
  function install(source: Source, options?: InstallBundleOptions) {
    if (source === "bundled") {
      return registry.installFromLocalZip("bundle.zip", {
        expectedPackageName: pkg,
        expectedVersion: mockVersion,
        ...options,
      })
    }
    if (source === "dev snapshot") {
      return registry.installFromUrl("http://localhost:8081/bundle.zip", {
        expectedPackageName: pkg,
        versionOverride: `dev-${Date.now()}`,
        releaseIdentity: {source: "dev_snapshot"},
        ...options,
      })
    }
    return registry.installFromUrl("https://manual.example/bundle.zip", {
      expectedPackageName: pkg,
      expectedVersion: mockVersion,
      releaseIdentity: {source: "direct_download"},
      ...options,
    })
  }

  function errorOf(result: Awaited<ReturnType<typeof install>>): string {
    return result.is_error() ? String(result.error.message) : ""
  }

  beforeEach(() => {
    selectDeployment(consumer)
    for (const key of ["url", "meta", "port", "mdns", "last_reachable", "selected_snapshot"]) {
      storage.remove(`${pkg}_dev_${key}`)
    }
    storage.remove("dev_apps_index")
  })

  it.each(["manual", "bundled"] as const)(
    "%s installs accept equal and newer versions and reject older ones",
    async (source) => {
      mockScript = "equal-version replacement"
      expect((await install(source)).is_ok()).toBe(true)
      expect(installedScript()).toBe("equal-version replacement")
      mockVersion = "2.1.30"
      mockScript = "upgrade"
      expect((await install(source)).is_ok()).toBe(true)
      mockVersion = "2.1.28"
      mockScript = "downgrade"
      const result = await install(source)
      expect(errorOf(result)).toContain("2.1.30 is already installed")
      expect(await registry.getActiveVersion(pkg)).toBe("2.1.30")
      expect(new File(registry.getBundleDir(pkg, "2.1.30"), "call.js").textSync()).toBe("upgrade")
      expect(registry.getInstalledVersions(pkg)).not.toContain("2.1.28")
    },
  )

  it("refuses a lower version at the shared preflight before any download", () => {
    mockVersion = "2.1.30"
    expect(() => registry.assertCanInstallVersion(pkg, "2.1.28")).toThrow("2.1.29 is already installed")
    expect(() => registry.assertCanInstallVersion(pkg, "2.1.29")).not.toThrow()
    expect(() => registry.assertCanInstallVersion(pkg, "dev-123")).not.toThrow()
  })

  it("reinstalls a same-version manual archive and commits its bytes and provenance", async () => {
    mockScript = "same-version replacement"
    expect((await install("manual")).is_ok()).toBe(true)
    expect(installedScript()).toBe("same-version replacement")
    expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("direct_download")
    expect(await registry.getActiveVersion(pkg)).toBe(version)
  })

  it("binds the archive to the package and version the source selected", async () => {
    const result = await registry.installFromUrl("https://manual.example/bundle.zip", {
      expectedPackageName: "com.example.other",
      expectedVersion: version,
    })
    expect(result.is_error()).toBe(true)
    expect(installedScript()).toBe("verified call")
  })

  it.each(["manual", "bundled", "dev snapshot"] as const)(
    "%s installs refuse a bundle signed by another publisher",
    async (source) => {
      mockPublisherFingerprint = "sha256:publisher-a"
      mockScript = "signed by A"
      expect((await install("manual")).is_ok()).toBe(true)
      expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")

      mockPublisherFingerprint = "sha256:publisher-b"
      mockScript = "signed by B"
      mockVersion = "2.1.30"
      const result = await install(source)
      expect(errorOf(result)).toContain("Publisher signature mismatch")
      expect(mockUnzip).toHaveBeenCalledTimes(2) // beforeEach + the accepted install; never the refused one
      expect(installedScript()).toBe("signed by A")
      expect(registry.getInstalledVersions(pkg)).toEqual([version])
      expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")
    },
  )

  it.each(["manual", "bundled", "dev snapshot"] as const)(
    "%s installs never let an unsigned bundle replace a signed install",
    async (source) => {
      mockPublisherFingerprint = "sha256:publisher-a"
      mockScript = "signed by A"
      expect((await install("manual")).is_ok()).toBe(true)

      mockPublisherFingerprint = undefined
      mockScript = "unsigned"
      mockVersion = "2.1.30"
      expect(errorOf(await install(source))).toContain(`Unsigned bundle cannot replace signed miniapp ${pkg}`)
      expect(installedScript()).toBe("signed by A")
      expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")

      // Uninstalling clears the recorded signer; then any bundle may install.
      expect((await registry.uninstall(pkg)).is_ok()).toBe(true)
      expect(registry.getPublisherKeyFingerprint(pkg)).toBeNull()
      expect((await install(source)).is_ok()).toBe(true)
      expect(registry.getPublisherKeyFingerprint(pkg)).toBeNull()
    },
  )

  it("a signed bundle replaces an unsigned install and pins the package to its key", async () => {
    expect(registry.getPublisherKeyFingerprint(pkg)).toBeNull()
    mockPublisherFingerprint = "sha256:publisher-a"
    mockScript = "signed by A"
    expect((await install("manual")).is_ok()).toBe(true)
    expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")
    expect(registry.getReleaseIdentity(pkg, version)?.publisherKeyFingerprint).toBe("sha256:publisher-a")

    mockVersion = "2.1.30"
    mockScript = "A again"
    expect((await install("bundled")).is_ok()).toBe(true)
    expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")

    mockPublisherFingerprint = undefined
    mockVersion = "2.1.31"
    expect(errorOf(await install("bundled"))).toContain("Unsigned bundle cannot replace signed miniapp")
  })

  it("never takes a publisher fingerprint from the caller", async () => {
    mockScript = "unsigned"
    expect(
      (
        await install("manual", {
          releaseIdentity: {source: "direct_download", publisherKeyFingerprint: "sha256:claimed"},
        })
      ).is_ok(),
    ).toBe(true)
    expect(registry.getPublisherKeyFingerprint(pkg)).toBeNull()
    expect(registry.getReleaseIdentity(pkg, version)?.publisherKeyFingerprint).toBeUndefined()
  })

  it("holds dev builds to the installed signer, and allows them again after uninstall", async () => {
    // Unsigned install + unsigned dev build: the dev build runs as the package.
    await registerDevApp(devRecord)
    expect(getDevAppRecords().map((record) => record.packageName)).toEqual([pkg])

    // A signed release pins the package and replaces the dev registration.
    mockPublisherFingerprint = "sha256:publisher-a"
    mockVersion = "2.1.30"
    expect((await install("manual")).is_ok()).toBe(true)
    expect(getDevAppRecords()).toEqual([])
    await expect(registerDevApp(devRecord)).rejects.toBeInstanceOf(SignedMiniappDevBuildError)
    expect(() => assertDevBuildAllowed(pkg)).toThrow("Uninstall it before running a development build")
    expect(storage.load(`${pkg}_dev_url`).is_error()).toBe(true)

    expect((await registry.uninstall(pkg)).is_ok()).toBe(true)
    expect(() => assertDevBuildAllowed(pkg)).not.toThrow()
    await registerDevApp(devRecord)
    expect(getDevAppRecords().map((record) => record.packageName)).toEqual([pkg])
  })

  it("clears development state only after a release installation commits", async () => {
    await registerDevApp(devRecord)
    expect((await install("dev snapshot")).is_ok()).toBe(true)
    expect(registry.hasDevSnapshot(pkg)).toBe(true)
    mockVersion = "2.1.30"
    expect((await install("manual")).is_ok()).toBe(true)
    expect(getDevAppRecords()).toEqual([])
    expect(storage.load(`${pkg}_dev_url`).is_error()).toBe(true)
    expect(registry.hasDevSnapshot(pkg)).toBe(false)
    expect(await registry.getActiveVersion(pkg)).toBe("2.1.30")
  })

  it("restores old same-version bytes, provenance and dev routing when a replacement cannot commit", async () => {
    await registerDevApp(devRecord)
    mockScript = "replacement"
    mockPublisherFingerprint = "sha256:publisher-a"
    mockFailNextActiveWrite = true
    const result = await install("manual")
    expect(errorOf(result)).toContain("Active version write failed")
    expect(installedScript()).toBe("verified call")
    expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
    expect(registry.getPublisherKeyFingerprint(pkg)).toBeNull()
    expect(storage.load(`${pkg}_dev_url`)).toMatchObject({value: devRecord.devUrl})
    expect(getDevAppRecords().map((record) => record.packageName)).toEqual([pkg])
    expect(new Directory(Paths.document, "lmas", pkg).list().map((entry) => entry.name)).toEqual([version])
  })

  it("removes a first install whose activation cannot commit", async () => {
    expect((await registry.uninstall(pkg)).is_ok()).toBe(true)
    mockFailNextActiveWrite = true
    expect(errorOf(await install("manual"))).toContain("Active version write failed")
    expect(registry.getInstalledVersions(pkg)).toEqual([])
    expect(registry.getReleaseIdentity(pkg, version)).toBeNull()
  })

  it("rejects a delayed download after a newer release installs", async () => {
    const entered = deferred()
    const release = deferred()
    mockRemoteRead.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    const pending = registry.installFromUrl("https://manual.example/bundle.zip")
    await entered.promise
    mockVersion = "2.1.31"
    mockScript = "newer release"
    expect((await install("bundled")).is_ok()).toBe(true)
    mockVersion = "2.1.30"
    mockScript = "late older release"
    release.resolve()
    expect((await pending).is_error()).toBe(true)
    expect(await registry.getActiveVersion(pkg)).toBe("2.1.31")
    expect(new File(registry.getBundleDir(pkg, "2.1.31"), "call.js").textSync()).toBe("newer release")
  })

  it("rechecks the signer inside the serialized install after a competing install commits", async () => {
    const entered = deferred()
    const release = deferred()
    mockRemoteRead.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    // Accepted at download time: nothing signed is installed yet.
    const pending = registry.installFromUrl("https://manual.example/bundle.zip")
    await entered.promise
    mockPublisherFingerprint = "sha256:publisher-a"
    mockVersion = "2.1.30"
    expect((await install("bundled")).is_ok()).toBe(true)
    mockPublisherFingerprint = undefined
    release.resolve()
    expect(errorOf(await pending)).toContain("Unsigned bundle cannot replace signed miniapp")
    expect(registry.getPublisherKeyFingerprint(pkg)).toBe("sha256:publisher-a")
  })

  it("extracts exactly the archive bytes that passed validation, not a file replaced later", async () => {
    mockValidatedArchives.length = 0
    const source = new File(Paths.cache, "caller-owned.zip")
    source.write("validated archive")
    let extractedFrom: string | undefined
    mockUnzip.mockImplementationOnce(async (zipPath: string) => {
      // Another writer replaces the caller's file while the install waits to extract.
      source.write("replacement archive")
      extractedFrom = zipPath
      mockScript = require("node:fs").readFileSync(zipPath, "utf8")
    })
    const result = await registry.installFromLocalZip(source.uri, {expectedPackageName: pkg, expectedVersion: version})
    expect(result.is_ok()).toBe(true)
    expect(mockValidatedArchives).toEqual(["validated archive"])
    expect(extractedFrom).not.toBe(source.uri)
    expect(installedScript()).toBe("validated archive")
    expect(source.textSync()).toBe("replacement archive")
    // The private copy is removed once the install settles.
    expect(new File(extractedFrom!).exists).toBe(false)
  })

  it("refuses a release whose download finishes after a dev build replacement started", async () => {
    await registerDevApp(devRecord)
    const entered = deferred()
    const download = deferred()
    mockRemoteRead.mockImplementationOnce(() => {
      entered.resolve()
      return download.promise
    })
    mockVersion = "2.1.30"
    const pending = install("manual")
    await entered.promise
    const releaseReplacement = registry.retainDevVersions(pkg, ["dev-1"])
    try {
      download.resolve()
      expect(errorOf(await pending)).toContain("during miniapp replacement")
      expect(mockUnzip).toHaveBeenCalledTimes(1) // beforeEach only
      expect(registry.getInstalledVersions(pkg)).toEqual([version])
      expect(storage.load(`${pkg}_dev_url`)).toMatchObject({value: devRecord.devUrl})
    } finally {
      releaseReplacement()
    }
  })

  it("rechecks the dev build replacement guard at the commit point", async () => {
    await registerDevApp(devRecord)
    let releaseReplacement: (() => void) | undefined
    mockScript = "release"
    const result = await install("manual", {
      // The replacement begins after the queue's checks, right before activation.
      beforeActivate: () => {
        releaseReplacement = registry.retainDevVersions(pkg, [])
      },
    })
    try {
      expect(errorOf(result)).toContain("during miniapp replacement")
      expect(installedScript()).toBe("verified call")
      expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
      expect(storage.load(`${pkg}_dev_url`)).toMatchObject({value: devRecord.devUrl})
    } finally {
      releaseReplacement?.()
    }
  })

  it("recovers an activation interrupted before commit on the next launch", async () => {
    // Simulate a crash after the candidate was moved into place and its
    // metadata applied, but before the pending marker was committed.
    const packageDir = new Directory(Paths.document, "lmas", pkg)
    const operation = "1800000000000"
    new Directory(packageDir, version).move(new Directory(packageDir, `.backup-${version}-${operation}`))
    new File(packageDir, version, "call.js").write("interrupted candidate")
    new File(packageDir, version, "miniapp.json").write(
      JSON.stringify({packageName: pkg, version, entry: {background: "call.js"}}),
    )
    const releaseKey = `miniapp_release_identity:${pkg}:${version}`
    const installation = createMMKV({id: "mentra-miniapp-installations"})
    const journal = {
      schemaVersion: 1,
      packageName: pkg,
      version,
      publisher: {present: false},
      release: {present: true, value: JSON.parse(installation.getString(releaseKey)!)},
      active: {present: true, value: version},
    }
    new File(packageDir, `.pending-existing-${version}-${operation}`, "metadata-rollback.json").write(
      JSON.stringify(journal),
    )
    installation.set(`miniapp_publisher_identity:${pkg}`, JSON.stringify("sha256:interrupted"))
    installation.set(releaseKey, JSON.stringify({source: "direct_download"}))
    // The pending candidate is never an installed version.
    expect(registry.getInstalledVersions(pkg)).toEqual([])

    const relaunched = new (registry.constructor as new () => typeof registry)()
    expect(relaunched.getInstalledVersions(pkg)).toEqual([version])
    expect(installedScript()).toBe("verified call")
    expect(relaunched.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
    expect(relaunched.getPublisherKeyFingerprint(pkg)).toBeNull()
    expect(packageDir.list().map((entry) => entry.name)).toEqual([version])
  })
})
