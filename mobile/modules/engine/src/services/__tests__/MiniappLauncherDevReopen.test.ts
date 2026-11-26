/// <reference types="bun-types" />

import {beforeAll, beforeEach, expect, it, mock, spyOn} from "bun:test"

import "./reactNativeTestMock"

import {configure} from "../../runtime/bootstrap"
import type {MentraJSRouter} from "../MentraJSRouter"

/** The dev server's current snapshot when it answers ("live"), else the last one on disk. */
let source = {kind: "live" as "live" | "snapshot", version: "dev-100"}
const respawns: string[] = []
const connects: string[] = []

mock.module("../../utils/devMiniappSnapshot", () => ({
  resolveDevBundleSource: async () => ({...source, resolvedUrl: "http://192.168.1.20:3160", manifest: {}}),
}))
mock.module("../AppRegistry", () => ({
  default: {
    isMiniappAccessRevoked: () => false,
    getActiveVersion: async () => source.version,
    getPublisherKeyFingerprint: () => null,
    getSelectedDevSnapshot: () => null,
    getMiniappEntryPaths: (_package: string, version: string) => ({
      background: `file:///bundle/${version}/bg.js`,
      rootDir: `file:///bundle/${version}/`,
      uiPath: "ui/index.html",
    }),
    getMiniappManifest: () => ({name: "Documentation"}),
    getReleaseIdentity: () => ({source: "dev_snapshot"}),
    isPackageAllowed: () => true,
  },
  getLocalAppRunningState: () => false,
  saveLocalAppRunningState: () => {},
}))
mock.module("../DevServerBridge", () => ({
  default: {
    connect: (_package: string, url: string) => connects.push(url),
    respawn: async (packageName: string) => void respawns.push(packageName),
  },
}))
mock.module("../LocalMiniappRuntime", () => ({default: {}}))
mock.module("../../utils/storage/storage", () => ({
  storage: {
    load: (key: string) =>
      key.endsWith("_dev_url")
        ? {is_ok: () => true, value: "http://192.168.1.20:3160/"}
        : {is_ok: () => key.endsWith("_dev_port"), value: 3161},
    save: () => ({is_ok: () => true}),
  },
}))
mock.module("expo-file-system", () => ({
  File: class {
    textSync = () => "BG"
  },
}))
mock.module("../../stores/settings", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSettingsStore: {getState: () => ({getSetting: () => false})},
}))

const PACKAGE = "com.mentra.documentation"
let miniappLauncher: typeof import("../MiniappLauncher").miniappLauncher

beforeAll(async () => {
  configure({auth: {}, config: {isMiniappAvailable: () => true}})
  miniappLauncher = (await import("../MiniappLauncher")).miniappLauncher
})

beforeEach(async () => {
  spyOn(console, "warn").mockImplementation(() => {})
  spyOn(console, "log").mockImplementation(() => {})
  const registered = new Set<string>()
  miniappLauncher.configure({
    router: {
      registeredPackages: () => [...registered],
      spawnAndRegister: async (packageName: string) => !!registered.add(packageName),
      projectRunning: () => {},
      isProjectedRunning: () => true,
      unregister: async (packageName: string) => void registered.delete(packageName),
    } as unknown as MentraJSRouter,
  })
  await miniappLauncher.stop(PACKAGE)
  respawns.length = 0
  connects.length = 0
})

it("restarts a reopened dev build that runs older code than its server serves", async () => {
  source = {kind: "live", version: "dev-100"}
  await miniappLauncher.ensureRunning(PACKAGE)
  await miniappLauncher.ensureRunning(PACKAGE)
  expect(respawns).toEqual([])

  source = {kind: "live", version: "dev-200"}
  await miniappLauncher.ensureRunning(PACKAGE)
  expect(respawns).toEqual([PACKAGE])
})

it("keeps listening after falling back to the last snapshot, and catches up once the server answers", async () => {
  source = {kind: "snapshot", version: "dev-100"}
  await miniappLauncher.ensureRunning(PACKAGE)
  expect(connects).toEqual(["http://192.168.1.20:3160/"])
  expect(await miniappLauncher.runsOutdatedDevBuild(PACKAGE)).toBe(false)

  source = {kind: "live", version: "dev-200"}
  expect(await miniappLauncher.runsOutdatedDevBuild(PACKAGE)).toBe(true)
})
