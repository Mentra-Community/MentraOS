/// <reference types="bun-types" />

import {afterAll, beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import "./reactNativeTestMock"
import {configure, resetForTests} from "../../runtime/bootstrap"

class CancelledError extends Error {}
let events: string[]
let installOptions: Record<string, unknown> | undefined
/** Fails the download, before anything is staged. */
let failDownload: Error | undefined
/** Fails once the build is staged, as the installer's checks inside its queue can. */
let failActivation: Error | undefined
let running: boolean
let developmentAllowed: boolean
/** Runs once the build's files have activated. */
let afterActivate: (() => void) | undefined

mock.module("../AppRegistry", () => ({
  default: {
    installFromUrl: async (url: string, options: Record<string, unknown>) => {
      events.push(`download ${url}`)
      installOptions = options
      if (failDownload) return Res.error(failDownload)
      events.push("staged")
      try {
        await (options.whenStaged as (() => Promise<void>) | undefined)?.()
        ;(options.beforeActivate as (() => void) | undefined)?.()
      } catch (error) {
        return Res.error(error as Error)
      }
      if (failActivation) return Res.error(failActivation)
      events.push(`activate ${String(options.versionOverride)}`)
      afterActivate?.()
      return Res.ok(undefined)
    },
    gcDevVersions: (_packageName: string, keep: number) => events.push(`gc ${keep}`),
  },
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
      beginUpdate: () => {
        events.push("updating")
        return () => events.push("updated")
      },
      refresh: async () => {
        events.push("refresh")
      },
    }),
  },
}))
mock.module("../miniappReleaseInstall", () => ({MiniappInstallCancelledError: CancelledError}))

const {installLocalBuild} = await import("../localBuildInstall")
type LocalBuildInstall = import("../localBuildInstall").LocalBuildInstall

const pkg = "com.mentra.notes"
const bundleUrl = "http://192.168.1.20:8080/bundle-abababab.zip"

function local(overrides: Partial<LocalBuildInstall> = {}): LocalBuildInstall {
  return {
    packageName: pkg,
    version: "1.0.0",
    sourceUrl: "http://192.168.1.20:8080/",
    sha256: "ab".repeat(32),
    reloadUrl: "ws://192.168.1.20:8081/__mentra_dev",
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
  failDownload = undefined
  failActivation = undefined
  running = false
  developmentAllowed = true
  afterActivate = undefined
})

describe("a local build", () => {
  test("installs as a development build of its package, recorded with its address, hash and console", async () => {
    await installLocalBuild(bundleUrl, local())
    const version = installOptions?.versionOverride as string
    expect(version).toMatch(/^dev-\d+$/)
    expect(installOptions).toMatchObject({
      expectedPackageName: pkg,
      expectedVersion: "1.0.0",
      expectedBundleSha256: "ab".repeat(32),
      releaseIdentity: {
        source: "local",
        sourceUrl: "http://192.168.1.20:8080/",
        bundleSha256: "ab".repeat(32),
        reloadUrl: "ws://192.168.1.20:8081/__mentra_dev",
      },
    })
    // Not running: nothing stops or starts, and the tile shows as updating only while the files commit.
    expect(events).toEqual([
      `download ${bundleUrl}`,
      "staged",
      "updating",
      "pause",
      `activate ${version}`,
      "gc 1",
      "resume",
      "updated",
      "refresh",
    ])
  })

  test("stops a running copy only once the new build is staged, then starts it again on it, without asking", async () => {
    running = true
    await installLocalBuild(bundleUrl, local())
    const version = installOptions?.versionOverride as string
    expect(events).toEqual([
      `download ${bundleUrl}`,
      "staged",
      "updating",
      "pause",
      "stop",
      `activate ${version}`,
      "gc 1",
      "resume",
      "updated",
      "launch",
      "refresh",
    ])
  })

  test("whose download fails leaves a running copy running what it ran", async () => {
    running = true
    failDownload = new Error("bundle SHA-256 mismatch")
    await expect(installLocalBuild(bundleUrl, local())).rejects.toThrow("SHA-256 mismatch")
    expect(events).toEqual([`download ${bundleUrl}`])
    expect(running).toBe(true)
  })

  test("that the installer refuses once staged starts the running copy again on the build it had", async () => {
    running = true
    failActivation = new Error("Unsigned bundle cannot replace signed miniapp com.mentra.notes; uninstall it first")
    await expect(installLocalBuild(bundleUrl, local())).rejects.toThrow("Unsigned bundle cannot replace")
    expect(events).toEqual([`download ${bundleUrl}`, "staged", "updating", "pause", "stop", "resume", "updated", "launch"])
  })

  test("is refused, before any download, where the deployment doesn't allow development", async () => {
    developmentAllowed = false
    await expect(installLocalBuild(bundleUrl, local())).rejects.toThrow("does not allow miniapp development")
    expect(events).toEqual([])
  })

  test("cancelled before its files activate, installs nothing and stops nothing", async () => {
    running = true
    await expect(installLocalBuild(bundleUrl, local({isCancelled: () => true}))).rejects.toBeInstanceOf(CancelledError)
    expect(events.some((event) => event.startsWith("activate"))).toBe(false)
    expect(events).not.toContain("stop")
  })

  test("whose session ends after its files activate doesn't start the miniapp again into it", async () => {
    running = true
    let cancelled = false
    afterActivate = () => {
      cancelled = true
    }
    await installLocalBuild(bundleUrl, local({isCancelled: () => cancelled}))
    expect(events).toContain("stop")
    expect(events).not.toContain("launch")
  })

  test("from an older CLI's release QR, without an address or a hash, binds the ZIP to its package and version", async () => {
    await installLocalBuild(bundleUrl, {packageName: pkg, version: "1.0.0"})
    expect(installOptions).not.toHaveProperty("expectedBundleSha256")
    expect(installOptions?.releaseIdentity).toEqual({source: "local"})
  })
})

describe("a local build's updates", () => {
  test("come from its own address only, whatever package it claims", async () => {
    const {miniappUpdateUrl} = await import("../miniappUrlUpdates")
    const deps = {
      isSystemPackage: () => true,
      firstPartyUrl: () => "https://miniapps.mentraglass.com/com.mentra.notes/",
    }
    expect(miniappUpdateUrl(pkg, {source: "local", sourceUrl: "http://192.168.1.20:8080/"}, deps)).toBe(
      "http://192.168.1.20:8080/",
    )
    // A release QR's build, and one an earlier Mentra App installed without its address, don't update.
    expect(miniappUpdateUrl(pkg, {source: "local"}, deps)).toBeUndefined()
    expect(miniappUpdateUrl(pkg, {source: "dev_snapshot"}, deps)).toBeUndefined()
  })
})
