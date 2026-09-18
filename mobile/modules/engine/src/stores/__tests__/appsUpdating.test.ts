import {beforeAll, beforeEach, describe, expect, mock, test} from "bun:test"
import {result as Res} from "typesafe-ts"

import type {ClientApp} from "../../types/applet"

const compatible = {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []}
const installedApps = mock(async (): Promise<ClientApp[]> => [])
const ensureRunning = mock(async () => ({}))
const uninstall = mock(async () => Res.ok(undefined))
mock.module("../../services/AppRegistry", () => ({
  default: {
    getInstalledMiniapps: installedApps,
    uninstall,
    requiresLocalSttModel: () => false,
    subscribe: () => () => {},
  },
}))
mock.module("../../services/MiniappLauncher", () => ({miniappLauncher: {ensureRunning}}))
mock.module("../../services/MiniappRunningRegistry", () => ({
  miniappRunningRegistry: {subscribe: () => () => {}, getAll: () => []},
}))
mock.module("../../services/LocalDisplayManager", () => ({default: {onCoreAppChange: () => {}}}))
mock.module("../../services/NotificationsEmitter", () => ({islandNotifications: {emit: () => {}}}))
mock.module("../../services/STTModelManager", () => ({default: {isModelAvailable: async () => true}}))
mock.module("../../services/SystemMiniappPolicy", () => ({isStoreMiniappPackage: () => false}))
mock.module("../../utils/hardware/hardware", () => ({HardwareCompatibility: {checkCompatibility: () => compatible}}))
mock.module("../../types/hardware", () => ({getModelCapabilities: () => ({})}))
mock.module("../../utils/storage/storage", () => ({
  storage: {load: () => ({is_ok: () => false}), save: () => ({is_ok: () => true})},
}))
mock.module("@mentra/bluetooth-sdk", () => ({default: {clearDisplay: () => {}}}))
mock.module("../settings", () => ({
  SETTINGS: {default_wearable: {key: "wearable"}, has_ever_activated_app: {key: "activated"}},
  useSettingsStore: {getState: () => ({getSetting: () => null, setSetting: () => {}}), subscribe: () => () => {}},
}))

let apps: typeof import("../apps").useAppStatusStore
let installHooks: typeof import("../apps").installAppStoreHooks
const blocked = mock(() => {})
const opened = mock(() => {})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

const target: ClientApp = {
  packageName: "com.test.notes",
  name: "Notes",
  webviewUrl: "",
  logoUrl: "",
  type: "background",
  permissions: [],
  running: false,
  healthy: true,
  hardwareRequirements: [],
  offline: false,
  offlineRoute: "",
  loading: false,
  local: true,
  hidden: false,
  compatibility: compatible,
}

beforeAll(async () => {
  const module = await import("../apps")
  apps = module.useAppStatusStore
  installHooks = module.installAppStoreHooks
})

beforeEach(() => {
  blocked.mockClear()
  opened.mockClear()
  ensureRunning.mockClear()
  uninstall.mockReset()
  uninstall.mockImplementation(async () => Res.ok(undefined))
  installedApps.mockReset()
  installedApps.mockResolvedValue([target])
  apps.setState({apps: [target], updatingPackages: new Set(), foregroundedPackage: null})
  installHooks({onUpdateBlocked: blocked, onOpenRequested: opened})
})

describe("miniapp update availability", () => {
  test("uninstall cannot delete a package while its update is downloading", async () => {
    const download = deferred()
    const update = apps.getState().runUpdate(target.packageName, () => download.promise)
    const result = await apps.getState().uninstall(target.packageName)
    expect(result.is_error()).toBe(true)
    expect(uninstall).not.toHaveBeenCalled()
    expect(apps.getState().apps).toHaveLength(1)
    download.resolve()
    await update
    expect((await apps.getState().uninstall(target.packageName)).is_ok()).toBe(true)
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  test("an update cannot start while uninstall is in progress", async () => {
    const deleting = deferred()
    uninstall.mockImplementationOnce(async () => {
      await deleting.promise
      return Res.ok(undefined)
    })
    const removal = apps.getState().uninstall(target.packageName)
    const install = mock(async () => {})
    try {
      await expect(apps.getState().runUpdate(target.packageName, install)).rejects.toThrow("being uninstalled")
      expect(install).not.toHaveBeenCalled()
    } finally {
      deleting.resolve()
      await removal
    }
    expect(apps.getState().apps).toHaveLength(0)
  })

  test.each([false, true])(
    "blocks opens until update settles, without queueing a launch (failure=%s)",
    async (fail) => {
      const download = deferred()
      const update = apps.getState().runUpdate(target.packageName, async () => {
        await download.promise
        if (fail) throw new Error("rollback complete")
      })
      const outcome = update.catch((error: Error) => error)
      expect(apps.getState().apps[0].updating).toBe(true)
      // Deliberately pass the old object captured before the update started.
      expect(await apps.getState().start(target)).toBe(false)
      await apps.getState().setForeground(target.packageName)
      expect(blocked).toHaveBeenCalledTimes(2)
      expect(opened).not.toHaveBeenCalled()
      expect(ensureRunning).not.toHaveBeenCalled()
      expect(apps.getState().foregroundedPackage).toBeNull()

      download.resolve()
      const result = await outcome
      if (fail) expect(result).toBeInstanceOf(Error)
      expect(apps.getState().apps[0].updating).toBe(false)
      expect(ensureRunning).not.toHaveBeenCalled()
      expect(await apps.getState().start(target)).toBe(true)
      expect(ensureRunning).toHaveBeenCalledTimes(1)
    },
  )

  test("an in-flight registry refresh cannot clear or resurrect update status", async () => {
    const read = deferred()
    installedApps.mockImplementationOnce(async () => {
      await read.promise
      return [target]
    })
    const refresh = apps.getState().refresh()
    const download = deferred()
    const update = apps.getState().runUpdate(target.packageName, () => download.promise)
    read.resolve()
    await refresh
    expect(apps.getState().apps[0].updating).toBe(true)
    apps.getState().setApps([target])
    expect(apps.getState().apps[0].updating).toBe(true)

    const secondRead = deferred()
    installedApps.mockImplementationOnce(async () => {
      await secondRead.promise
      return [target]
    })
    const secondRefresh = apps.getState().refresh()
    download.resolve()
    await update
    secondRead.resolve()
    await secondRefresh
    expect(apps.getState().apps[0].updating).toBe(false)
  })

  test("updating one miniapp does not block another", async () => {
    const other = {...target, packageName: "com.test.other"}
    apps.getState().setApps([target, other])
    const download = deferred()
    const update = apps.getState().runUpdate(target.packageName, () => download.promise)
    try {
      expect(await apps.getState().start(other)).toBe(true)
      expect(blocked).not.toHaveBeenCalled()
      expect(apps.getState().apps[1].updating).toBe(false)
    } finally {
      download.resolve()
      await update
    }
  })
})
