/// <reference types="bun-types" />

import {afterAll, beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import "./reactNativeTestMock"
import {configure, resetForTests} from "../../runtime/bootstrap"
import {createDevSnapshotRequest} from "../../utils/devSnapshotRequests"

class CancelledError extends Error {}
let events: string[]
let installOptions: Record<string, unknown> | undefined
let failInstall: Error | undefined
let fingerprint: string | null
let running: boolean
let developmentAllowed: boolean
/** Runs once the snapshot's files have activated. */
let afterActivate: (() => void) | undefined
const selected: Array<[string, string | null]> = []
const registered: Array<Record<string, unknown>> = []
/** What `registerDevApp` is handed to check, after its icon download, before it writes. */
let registeredAssertCurrent: Array<(() => void) | undefined>

mock.module("../AppRegistry", () => ({
  default: {
    installFromUrl: async (url: string, options: Record<string, unknown>) => {
      events.push(`install ${url}`)
      installOptions = options
      if (failInstall) return Res.error(failInstall)
      ;(options.beforeActivate as (() => void) | undefined)?.()
      events.push(`activate ${String(options.versionOverride)}`)
      afterActivate?.()
      return Res.ok(undefined)
    },
    getPublisherKeyFingerprint: () => fingerprint,
    selectDevSnapshot: (packageName: string, version: string | null) => {
      events.push("select")
      selected.push([packageName, version])
    },
    gcDevVersions: (_packageName: string, keep: number) => events.push(`gc ${keep}`),
    clearDevelopmentSelection: async (_packageName: string, options?: {assertCurrent?: () => void}) => {
      // The real one runs the check once it holds the install queue.
      options?.assertCurrent?.()
      events.push("clear development")
      return true
    },
  },
  registerDevApp: async (record: Record<string, unknown>, options?: {assertCurrent?: () => void}) => {
    registeredAssertCurrent.push(options?.assertCurrent)
    options?.assertCurrent?.()
    events.push("register")
    registered.push(record)
  },
  unregisterDevApp: () => events.push("unregister"),
}))
mock.module("../MiniappLauncher", () => ({
  miniappLauncher: {
    pauseLaunches: async () => {
      events.push("pause")
      return () => events.push("resume")
    },
    isRunning: () => running,
    stop: async () => {
      events.push("stop")
      running = false
    },
    ensureRunning: async () => {
      events.push("launch")
      running = true
    },
  },
}))
mock.module("../../stores/apps", () => ({
  useAppStatusStore: {
    getState: () => ({
      runUpdate: async (_packageName: string, update: () => Promise<unknown>) => update(),
      refresh: async () => {
        events.push("refresh")
      },
    }),
  },
}))
mock.module("../miniappReleaseInstall", () => ({MiniappInstallCancelledError: CancelledError}))

const {installLocalBuild, restoreInstalledRelease} = await import("../localBuildInstall")
type LocalBuildInstall = import("../localBuildInstall").LocalBuildInstall

const pkg = "com.mentra.notes"
const bundleUrl = "http://192.168.1.20:8080/bundle.zip"
const server = {
  name: "Notes (dev)",
  iconUrl: "http://192.168.1.20:8080/icon.png",
  devUrl: "http://192.168.1.20:8080",
  devPort: 8081,
  mdnsHost: "laptop.local",
}

function local(overrides: Partial<LocalBuildInstall> = {}): LocalBuildInstall {
  return {
    packageName: pkg,
    version: "1.0.0",
    sourceUrl: "http://192.168.1.20:8080/",
    sha256: "ab".repeat(32),
    ...overrides,
  }
}

beforeAll(() => {
  configure({auth: {}, config: {isLocalMiniappAllowed: () => developmentAllowed}})
})
afterAll(resetForTests)

beforeEach(() => {
  events = []
  installOptions = undefined
  failInstall = undefined
  fingerprint = null
  running = false
  developmentAllowed = true
  selected.length = 0
  registered.length = 0
  registeredAssertCurrent = []
  afterActivate = undefined
})

describe("a local-network build", () => {
  test("installs as a development snapshot of its package, recorded as a local build at its address", async () => {
    await installLocalBuild(bundleUrl, local())
    const version = installOptions?.versionOverride as string
    expect(version).toMatch(/^dev-\d+$/)
    expect(installOptions).toMatchObject({
      expectedPackageName: pkg,
      expectedVersion: "1.0.0",
      expectedBundleSha256: "ab".repeat(32),
      releaseIdentity: {source: "local", sourceUrl: "http://192.168.1.20:8080/", bundleSha256: "ab".repeat(32)},
    })
    // No development server: the snapshot is the selected build, over any earlier scan of the package.
    expect(selected).toEqual([[pkg, version]])
    expect(events).toEqual([
      "pause",
      `install ${bundleUrl}`,
      `activate ${version}`,
      "unregister",
      "select",
      "gc 1",
      "resume",
      "refresh",
    ])
  })

  test("with a development server, loads live from it and reloads over its channel", async () => {
    await installLocalBuild(bundleUrl, local({server}))
    expect(registered).toEqual([{...server, packageName: pkg}])
    expect(selected).toEqual([])
    expect(events).toContain("register")
    expect(events).not.toContain("unregister")
  })

  test("signed, it runs its snapshot: live code from its server is unsigned", async () => {
    // The snapshot's signature recorded the package's publisher.
    fingerprint = "sha256:publisher"
    await installLocalBuild(bundleUrl, local({server}))
    expect(registered).toEqual([])
    expect(selected.map(([name]) => name)).toEqual([pkg])
  })

  test("stops a running copy of the package and starts it again on the new build", async () => {
    running = true
    await installLocalBuild(bundleUrl, local())
    expect(events.slice(0, 3)).toEqual(["pause", "stop", `install ${bundleUrl}`])
    expect(events.slice(-3)).toEqual(["resume", "launch", "refresh"])
  })

  test("supersedes a snapshot download an earlier development launch started", async () => {
    const earlier = createDevSnapshotRequest(pkg)
    await installLocalBuild(bundleUrl, local())
    expect(earlier.isCurrent()).toBe(false)
  })

  test("is refused, before any download, where the deployment doesn't allow development", async () => {
    developmentAllowed = false
    await expect(installLocalBuild(bundleUrl, local())).rejects.toThrow("does not allow miniapp development")
    expect(events).toEqual([])
  })

  test("that the installer refuses leaves the package's routing alone", async () => {
    running = true
    failInstall = new Error("Unsigned bundle cannot replace signed miniapp com.mentra.notes; uninstall it first")
    await expect(installLocalBuild(bundleUrl, local({server}))).rejects.toThrow("Unsigned bundle cannot replace")
    expect(registered).toEqual([])
    expect(selected).toEqual([])
    expect(events).toEqual(["pause", "stop", `install ${bundleUrl}`, "resume", "launch"])
  })

  test("cancelled before its files activate, installs nothing", async () => {
    await expect(installLocalBuild(bundleUrl, local({isCancelled: () => true}))).rejects.toBeInstanceOf(CancelledError)
    expect(events.some((event) => event.startsWith("activate"))).toBe(false)
    expect(selected).toEqual([])
  })

  test.each([
    ["with a development server", true],
    ["without one", false],
  ])("whose session ends after its files activate selects nothing (%s)", async (_name, withServer) => {
    let cancelled = false
    afterActivate = () => {
      cancelled = true
    }
    const installing = installLocalBuild(
      bundleUrl,
      local({...(withServer ? {server} : {}), isCancelled: () => cancelled}),
    )
    await expect(installing).rejects.toBeInstanceOf(CancelledError)
    expect(registered).toEqual([])
    expect(selected).toEqual([])
    expect(events).not.toContain("unregister")
  })

  test("hands its session check to the dev record, which runs it after its icon download", async () => {
    let cancelled = false
    await installLocalBuild(bundleUrl, local({server, isCancelled: () => cancelled}))
    const check = registeredAssertCurrent[0]!
    expect(check).toBeInstanceOf(Function)
    cancelled = true
    expect(check).toThrow(CancelledError)
  })

  test("without a hash in its miniapp.json, binds the ZIP to its package and version only", async () => {
    await installLocalBuild(bundleUrl, local({sha256: undefined}))
    expect(installOptions).not.toHaveProperty("expectedBundleSha256")
    expect(installOptions?.releaseIdentity).toEqual({source: "local", sourceUrl: "http://192.168.1.20:8080/"})
  })
})

describe("a local build's updates", () => {
  test("never come from a URL, its own address included", async () => {
    const {miniappUpdateUrl} = await import("../miniappUrlUpdates")
    const deps = {
      isSystemPackage: () => true,
      firstPartyUrl: () => "https://miniapps.mentraglass.com/com.mentra.notes/",
    }
    expect(miniappUpdateUrl(pkg, {source: "local", sourceUrl: "http://192.168.1.20:8080/"}, deps)).toBeUndefined()
    expect(miniappUpdateUrl(pkg, {source: "dev_snapshot"}, deps)).toBeUndefined()
  })
})

describe("restoring the installed release over a development build", () => {
  test("clears the development build and restarts a running copy on the release", async () => {
    running = true
    await restoreInstalledRelease(pkg)
    expect(events).toEqual(["pause", "stop", "clear development", "resume", "launch", "refresh"])
  })

  test("hands its session check to the queued clear", async () => {
    let cancelled = false
    await restoreInstalledRelease(pkg, {isCancelled: () => cancelled})
    expect(events).toContain("clear development")
    events = []
    // A session that ends between the restore's own check and the queued clear.
    const restoring = restoreInstalledRelease(pkg, {
      isCancelled: () => {
        const ended = cancelled
        cancelled = true
        return ended
      },
    })
    await expect(restoring).rejects.toBeInstanceOf(CancelledError)
    expect(events).not.toContain("clear development")
  })

  test("whose session ended clears nothing", async () => {
    await expect(restoreInstalledRelease(pkg, {isCancelled: () => true})).rejects.toBeInstanceOf(CancelledError)
    expect(events).not.toContain("clear development")
  })
})
