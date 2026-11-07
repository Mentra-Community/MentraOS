import {engine} from "@mentra/engine"
import {appRegistry, getDevAppRecords} from "@mentra/engine-host-internal"

import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment, WorkspaceDeployment} from "@/services/deployment/types"
import {storage} from "@/utils/storage"

import {useDefaultMiniappsStore} from "@/stores/defaultMiniapps"

import {defaultMiniapps} from "./defaultMiniapps"
import {shouldSkipMiniappInstall} from "./miniappVisibility"

jest.mock("@mentra/engine-host-internal", () => {
  class InstallMiniappError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    appRegistry: {getInstalledVersions: jest.fn(() => [])},
    getDevAppRecords: jest.fn(() => []),
    firstPartyMiniappUrl: jest.requireActual("../../../modules/engine/src/services/systemMiniappTrust")
      .firstPartyMiniappUrl,
    InstallMiniappError,
  }
})
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://core.example", runtime: "https://runtime.example"}),
}))
jest.mock("./miniappVisibility", () => ({shouldSkipMiniappInstall: jest.fn(() => false)}))

const {InstallMiniappError} = jest.requireMock("@mentra/engine-host-internal") as {
  InstallMiniappError: new (code: string, message: string) => Error
}
const install = jest.fn()
Object.assign(engine.miniapps, {install})
const installedVersions = appRegistry.getInstalledVersions as jest.Mock
const CACHE_KEY = "deployment_default_miniapps:v1"

function coreServes(defaults: string[]) {
  global.fetch = jest.fn(async () => ({ok: true, status: 200, json: async () => ({miniapps: {defaults}})})) as never
}

function coreUnreachable() {
  global.fetch = jest.fn(async () => {
    throw new TypeError("Network request failed")
  }) as never
}

function activate(deployment: ActiveDeployment) {
  jest.spyOn(deploymentStore, "getActive").mockReturnValue(deployment)
  return deployment
}

function workspace(overrides: Partial<WorkspaceDeployment["manifest"]> = {}): WorkspaceDeployment {
  const consumer = createConsumerDeployment()
  return {
    kind: "workspace",
    source: "manual",
    activatedAt: "2026-11-06T00:00:00Z",
    workspaceOrigin: "https://workspace.example",
    manifestUrl: "https://workspace.example/.well-known/mentra-deployment.json",
    manifest: {
      ...consumer.manifest,
      deploymentId: "acme",
      artifacts: {...consumer.manifest.artifacts, firstPartyMiniappsUrl: "https://miniapps.mentraglass.com/"},
      ...overrides,
    },
  }
}

describe("default miniapps", () => {
  beforeEach(() => {
    storage.remove(CACHE_KEY)
    install.mockReset().mockResolvedValue({status: "installed"})
    installedVersions.mockReset().mockReturnValue([])
    ;(getDevAppRecords as jest.Mock).mockReturnValue([])
    ;(shouldSkipMiniappInstall as jest.Mock).mockReturnValue(false)
    defaultMiniapps.reset()
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it("installs each missing default from the deployment's miniapp host, as a system install", async () => {
    const deployment = activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes"])
    installedVersions.mockImplementation((name: string) => (name === "com.mentra.notes" ? ["1.0.30"] : []))

    await defaultMiniapps.sync()

    expect(global.fetch).toHaveBeenCalledWith("https://core.example/api/client/deployment", expect.anything())
    const host = deployment.manifest.artifacts.firstPartyMiniappsUrl
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith(`${host}com.mentra.ai/`, {
      source: "system",
      expectedPackageName: "com.mentra.ai",
      isCancelled: expect.any(Function),
    })
    expect(useDefaultMiniappsStore.getState()).toEqual({status: "idle", pending: []})
  })

  it("leaves a QR development build, and a package the platform or Super Mode hides", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.notes", "com.mentra.link"])
    ;(getDevAppRecords as jest.Mock).mockReturnValue([{packageName: "com.mentra.notes"}])
    ;(shouldSkipMiniappInstall as jest.Mock).mockImplementation((name: string) => name === "com.mentra.link")

    await defaultMiniapps.sync()

    expect(install).not.toHaveBeenCalled()
  })

  it("installs from the last list Core served when Core can't be reached, and waits when it never answered", async () => {
    activate(createConsumerDeployment())
    coreUnreachable()
    await defaultMiniapps.sync()
    expect(install).not.toHaveBeenCalled()
    expect(useDefaultMiniappsStore.getState()).toEqual({status: "waiting", pending: []})

    coreServes(["com.mentra.ai"])
    await defaultMiniapps.sync()
    install.mockClear()
    coreUnreachable()
    await defaultMiniapps.sync()
    expect(install).toHaveBeenCalledWith(expect.stringContaining("com.mentra.ai/"), expect.anything())
  })

  it("ignores a list another Core served", async () => {
    activate(createConsumerDeployment())
    storage.save(CACHE_KEY, {coreUrl: "https://other-core.example", defaults: ["com.mentra.ai"]})
    coreUnreachable()

    await defaultMiniapps.sync()

    expect(install).not.toHaveBeenCalled()
  })

  it("keeps a default that couldn't download pending, and drops one the installer refused", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes", "com.mentra.merge"])
    install.mockImplementation(async (url: string) => {
      if (url.includes("com.mentra.ai/")) throw new InstallMiniappError("network", "offline")
      if (url.includes("com.mentra.notes/")) throw new InstallMiniappError("needs_newer_app", "too new")
      return {status: "installed"}
    })

    await defaultMiniapps.sync()

    expect(install).toHaveBeenCalledTimes(3)
    expect(useDefaultMiniappsStore.getState()).toEqual({status: "waiting", pending: ["com.mentra.ai"]})
  })

  it("installs a workspace's own defaults, except those it pins or leaves out of its system list", async () => {
    const pinned = {
      packageName: "com.mentra.call",
      version: "2.1.74",
      bundleUrl: "https://workspace.example/miniapps/call.zip",
      sha256: "a".repeat(64),
    }
    activate(
      workspace({
        systemMiniapps: {approvedPackageNamesOverride: ["com.mentra.ai", "com.mentra.call"]},
        miniapps: {
          managed: [pinned],
          defaults: ["com.mentra.ai", "com.mentra.call", "com.mentra.notes"],
          configuration: {},
        },
      }),
    )
    global.fetch = jest.fn() as never

    await defaultMiniapps.sync()

    expect(global.fetch).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith("https://miniapps.mentraglass.com/com.mentra.ai/", expect.anything())
  })

  it("installs nothing for a workspace that names no miniapp host", async () => {
    const deployment = workspace({miniapps: {managed: [], defaults: ["com.mentra.ai"], configuration: {}}})
    deployment.manifest.artifacts = {...deployment.manifest.artifacts, firstPartyMiniappsUrl: null}
    activate(deployment)

    await defaultMiniapps.sync()

    expect(install).not.toHaveBeenCalled()
    expect(useDefaultMiniappsStore.getState()).toEqual({status: "idle", pending: []})
  })

  it("stops when the deployment changes", async () => {
    const consumer = activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes"])
    install.mockImplementation(async () => {
      jest.spyOn(deploymentStore, "getActive").mockReturnValue(workspace())
      return {status: "installed"}
    })

    await defaultMiniapps.sync()

    expect(consumer.kind).toBe("consumer")
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("runs once more after the pass in progress, for every call made meanwhile", async () => {
    activate(createConsumerDeployment())
    coreServes([])
    const first = defaultMiniapps.sync()
    const second = defaultMiniapps.sync()
    const third = defaultMiniapps.sync()
    expect(second).toBe(third)
    await Promise.all([first, second, third])
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
