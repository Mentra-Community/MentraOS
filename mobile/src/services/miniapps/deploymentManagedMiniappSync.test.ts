import {File, Paths} from "expo-file-system"
import registry from "../../../modules/engine/src/services/AppRegistry"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {deploymentStore} from "@/services/deployment/store"
import type {WorkspaceDeployment} from "@/services/deployment/types"
import {deploymentManagedMiniappSync} from "./deploymentManagedMiniappSync"
import {shouldHideMiniapp} from "./miniappVisibility"

let mockDigest = "a".repeat(64)
let mockScript = "verified call"
const mockDownload = jest.fn()

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
      return Uint8Array.from(fs.readFileSync(this.uri))
    }
    write(value: string) {
      fs.mkdirSync(path.dirname(this.uri), {recursive: true})
      fs.writeFileSync(this.uri, value)
    }
    delete() {
      fs.rmSync(this.uri)
    }
    move(target: TestDirectory) {
      const dest = path.join(target.uri, this.name)
      fs.renameSync(this.uri, dest)
      this.uri = dest
    }
    static async downloadFileAsync(url: string, target: TestFile) {
      mockDownload(url)
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
      const dest = path.join(target.uri, this.name)
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
    const {File} = require("expo-file-system")
    new File(target, "miniapp.json").write(JSON.stringify({packageName: "com.mentra.call", version: "2.1.29"}))
    new File(target, "call.js").write(mockScript)
    new File(target, "ui", "index.js").write("verified nested UI")
  },
}))
jest.mock("../../../modules/engine/src/utils/storage/zip", () => ({printDirectory: jest.fn()}))
jest.mock("@mentra/engine-host-internal", () => ({
  appRegistry: jest.requireActual("../../../modules/engine/src/services/AppRegistry").default,
}))
jest.mock("./preinstalledMiniappSync", () => ({sha256Hex: async () => mockDigest}))
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

beforeEach(async () => {
  const fs = require("node:fs")
  for (const dir of [Paths.document, Paths.cache]) fs.rmSync(dir, {recursive: true, force: true})
  mockDownload.mockClear()
  mockDigest = "a".repeat(64)
  mockScript = "verified call"
  jest.spyOn(deploymentStore, "getActive").mockReturnValue(workspace)
  expect((await registry.installFromLocalZip("consumer.zip")).is_ok()).toBe(true)
  expect(registry.getReleaseIdentity(pkg, version)?.source).toBe("bundled_asset")
})
afterEach(() => jest.restoreAllMocks())
afterAll(() => require("node:fs").rmSync(require("node:path").dirname(Paths.document), {recursive: true, force: true}))

it("adopts an identical verified consumer release and restores consumer installation on workspace exit", async () => {
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
  jest.spyOn(deploymentStore, "getActive").mockReturnValue(consumer)
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
