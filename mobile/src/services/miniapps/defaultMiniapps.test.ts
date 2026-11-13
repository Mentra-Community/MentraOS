import {engine} from "@mentra/engine"
import {appRegistry, getDevAppRecords} from "@mentra/engine-host-internal"

import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment, WorkspaceDeployment} from "@/services/deployment/types"
import {storage} from "@/utils/storage"

import {useDefaultMiniappsStore} from "@/stores/defaultMiniapps"
import {startMiniappOpenWait, useMiniappOpenWaitStore} from "@/stores/miniappOpenWait"

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
const readListing = jest.fn()
Object.assign(engine.miniapps, {install, readListing})
const installedVersions = appRegistry.getInstalledVersions as jest.Mock
const CACHE_KEY = "deployment_default_miniapps:v1"
const LISTINGS_KEY = "deployment_default_miniapp_listings:v1"
const IDLE = {status: "idle", pending: [], listings: {}, failed: []}

/** What a host's `miniapp.json` says: `com.mentra.ai` is called "ai", with an icon beside it. */
function listingFor(url: string) {
  const packageName = url.split("/").filter(Boolean).pop()!
  return {packageName, name: packageName.split(".").pop()!, iconUrl: `${url}icon.png`, version: "1.0.0"}
}

const packageOf = (url: string) => url.split("/").filter(Boolean).pop()!

/** Installs stay installed, so a later pass finds nothing missing. Returns the packages installed. */
function trackInstalls(): Set<string> {
  const installed = new Set<string>()
  installedVersions.mockImplementation((name: string) => (installed.has(name) ? ["1.0.0"] : []))
  install.mockImplementation(async (url: string) => {
    installed.add(packageOf(url))
    return {status: "installed"}
  })
  return installed
}

/** Let the listings, read in parallel with the installs, land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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
    storage.remove(LISTINGS_KEY)
    install.mockReset().mockResolvedValue({status: "installed"})
    readListing.mockReset().mockImplementation(async (url: string) => listingFor(url))
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
    expect(useDefaultMiniappsStore.getState()).toEqual(IDLE)
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
    expect(useDefaultMiniappsStore.getState()).toEqual({status: "waiting", pending: [], listings: {}, failed: []})

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
    expect(useDefaultMiniappsStore.getState()).toMatchObject({
      status: "waiting",
      pending: ["com.mentra.ai"],
      failed: ["com.mentra.notes"],
    })
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
    expect(useDefaultMiniappsStore.getState()).toEqual(IDLE)
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

  it("shows each pending default by its miniapp.json while it installs, and drops it once installed", async () => {
    const deployment = activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes"])
    let finish!: () => void
    install.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({status: "installed"}))))

    const pass = defaultMiniapps.sync()
    await settle()

    const host = deployment.manifest.artifacts.firstPartyMiniappsUrl
    expect(readListing).toHaveBeenCalledWith(`${host}com.mentra.ai/`)
    expect(readListing).toHaveBeenCalledWith(`${host}com.mentra.notes/`)
    expect(useDefaultMiniappsStore.getState()).toMatchObject({
      status: "installing",
      listings: {
        "com.mentra.ai": {name: "ai", iconUrl: `${host}com.mentra.ai/icon.png`, version: "1.0.0"},
        "com.mentra.notes": {name: "notes", iconUrl: `${host}com.mentra.notes/icon.png`, version: "1.0.0"},
      },
    })

    finish()
    await pass
    expect(useDefaultMiniappsStore.getState()).toEqual(IDLE)
  })

  it("keeps the listings of defaults still pending, to show them at the next launch", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai"])
    install.mockRejectedValue(new InstallMiniappError("network", "offline"))
    await defaultMiniapps.sync()
    await settle()

    defaultMiniapps.reset()
    readListing.mockRejectedValue(new InstallMiniappError("network", "offline"))
    await defaultMiniapps.sync()

    expect(useDefaultMiniappsStore.getState()).toMatchObject({
      status: "waiting",
      pending: ["com.mentra.ai"],
      listings: {"com.mentra.ai": {name: "ai"}},
    })
  })

  it("shows no listing a miniapp.json names another package for", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai"])
    install.mockRejectedValue(new InstallMiniappError("network", "offline"))
    readListing.mockResolvedValue({packageName: "com.other.app", name: "Other", iconUrl: null, version: "1.0.0"})

    await defaultMiniapps.sync()
    await settle()

    expect(useDefaultMiniappsStore.getState().listings).toEqual({})
  })

  it("installs the default the person waits for next", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes", "com.mentra.merge"])
    const installed = trackInstalls()
    let finish!: () => void
    install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            installed.add("com.mentra.ai")
            resolve({status: "installed"})
          }
        }),
    )

    const pass = defaultMiniapps.sync()
    await settle()
    defaultMiniapps.prioritize("com.mentra.merge")
    finish()
    await pass
    await defaultMiniapps.sync()

    expect(install.mock.calls.map(([url]) => packageOf(url))).toEqual([
      "com.mentra.ai",
      "com.mentra.merge",
      "com.mentra.notes",
    ])
  })

  it("tries a default the person waits for again when its download waited for a connection", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai"])
    trackInstalls()
    install.mockRejectedValueOnce(new InstallMiniappError("network", "offline"))
    await defaultMiniapps.sync()
    expect(useDefaultMiniappsStore.getState().status).toBe("waiting")

    defaultMiniapps.prioritize("com.mentra.ai")
    await defaultMiniapps.sync()

    expect(install).toHaveBeenCalledTimes(2)
    expect(useDefaultMiniappsStore.getState()).toEqual(IDLE)
  })

  it("shows no tile for a default its install refused, on the passes that try it again", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.notes"])
    install.mockRejectedValue(new InstallMiniappError("needs_newer_app", "too new"))
    await defaultMiniapps.sync()
    await settle()

    let finish!: () => void
    install.mockImplementationOnce(
      () => new Promise((_, reject) => (finish = () => reject(new InstallMiniappError("needs_newer_app", "too new")))),
    )
    const pass = defaultMiniapps.sync()
    await settle()
    expect(useDefaultMiniappsStore.getState()).toMatchObject({
      status: "installing",
      listings: {},
      failed: ["com.mentra.notes"],
    })
    finish()
    await pass
  })

  it("logout stops the pass in progress, and ends a miniapp's wait to open", async () => {
    activate(createConsumerDeployment())
    coreServes(["com.mentra.ai", "com.mentra.notes"])
    let finish!: () => void
    install.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({status: "installed"}))))
    const pass = defaultMiniapps.sync()
    await settle()
    startMiniappOpenWait({packageName: "com.mentra.ai", name: "ai", logoUrl: ""} as never, async () => {})

    defaultMiniapps.reset()
    finish()
    await pass
    await settle()

    expect(install).toHaveBeenCalledTimes(1)
    expect(useDefaultMiniappsStore.getState()).toEqual(IDLE)
    expect(useMiniappOpenWaitStore.getState().wait).toBeNull()
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
