import {expect, test} from "bun:test"
import type {NativeFirmwareStartRequest, NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {Ar99FirmwareProvider, type Ar99FirmwarePorts} from "../provider"

function fixture() {
  const target = {integrationId: "ar99", deviceId: "native-ar99", displayName: "AR99"}
  let native: NativeFirmwareUpdateSnapshot = {
    ...target,
    schemaVersion: 1,
    updaterId: "updater",
    revision: 0,
    connectionGeneration: 1,
    phase: "idle",
    safeToRelease: true,
    canCancel: false,
    canReconcile: false,
    observedFirmware: "old",
    inventory: {serialNumber: "serial", projectName: "AR99"},
  }
  const listeners = new Set<(value: NativeFirmwareUpdateSnapshot) => void>()
  const requests: NativeFirmwareStartRequest[] = []
  let ids = 0,
    releases = 0,
    held = 0,
    lookups = 0
  const emit = (patch: Partial<NativeFirmwareUpdateSnapshot>) => {
    native = {...native, ...patch, revision: native.revision + 1}
    for (const listener of listeners) listener(native)
    return native
  }
  const ports: Ar99FirmwarePorts = {
    read: async () => native,
    listen: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    validateTarget: async () => {},
    refreshInventory: async () => native,
    reconcile: async () => native,
    start: async (request) => {
      requests.push(request)
      return emit({sessionId: "session", offerId: request.offerId, phase: "preparing", safeToRelease: false})
    },
    acknowledge: async () => emit({phase: "idle", sessionId: undefined}),
    source: () => ({baseUrl: "https://example.invalid/", developerId: "vendor", clientKey: "test"}),
    lookup: async () => {
      lookups++
      return {
        hasUpdate: true,
        currentVersion: "new",
        changeLog: "Changes",
        fileMd5: "",
        firmwareUrl: "https://example.invalid/fw",
        forceUpdate: false,
      }
    },
    stage: async () => ({
      artifact: {path: "/file", size: 10, sha256: "a".repeat(64), targetVersion: "new"},
      release: async () => {
        releases++
      },
    }),
    acquireRuntime: () => {
      held++
      return () => {
        held--
      }
    },
    id: () => `id-${++ids}`,
  }
  return {
    ports,
    provider: new Ar99FirmwareProvider(target, ports),
    emit,
    requests,
    releases: () => releases,
    held: () => held,
    lookups: () => lookups,
  }
}

test("AR99 approval, pause and remount follow one native operation without replacing the observed version", async () => {
  const f = fixture()
  await f.provider.open({entryPoint: "settings"})
  await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
  f.emit({phase: "paused"})
  await f.provider.open({entryPoint: "recovery"})
  expect(f.requests).toHaveLength(1)
  expect(f.lookups()).toBe(1)
  expect(f.held()).toBe(1)
  expect(f.provider.snapshot().presentation.title.key).toBe("ar99Ota:waitingForReconnect")
  expect(f.provider.snapshot().presentation.actions).toEqual([])
  f.emit({phase: "complete", safeToRelease: true, inventory: {activation: "unverified"}})
  expect(f.provider.snapshot().details).toMatchObject({observedVersion: "old", activation: "unverified"})
  expect(f.provider.snapshot().presentation.message?.text).toContain("has not yet been confirmed")
  expect(f.held()).toBe(0)
  expect(await f.provider.perform({action: "finish"})).toEqual({kind: "finished"})
  expect(f.releases()).toBe(1)
})
test("organization denial makes no vendor request and still adopts retained local recovery", async () => {
  const f = fixture()
  f.ports.source = () => null
  await f.provider.open({entryPoint: "settings"})
  expect(f.provider.snapshot().phase).toBe("unavailable")
  expect(f.lookups()).toBe(0)
  f.emit({phase: "paused", sessionId: "retained", safeToRelease: false})
  expect(f.provider.snapshot().nativeSessionId).toBe("retained")
})
test.each(["source", "connection", "serial", "teardown"])(
  "%s change during download cannot flash the previously approved offer",
  async (change) => {
    const f = fixture()
    await f.provider.open({entryPoint: "settings"})
    const stage = f.ports.stage
    f.ports.stage = async (...args) => {
      if (change === "source") f.ports.source = () => null
      if (change === "connection") f.emit({connectionGeneration: 2})
      if (change === "serial") f.emit({inventory: {serialNumber: "other", projectName: "AR99"}})
      if (change === "teardown") f.provider.suspendNewWork()
      return stage(...args)
    }
    await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
    expect(f.requests).toHaveLength(0)
    expect(f.releases()).toBe(1)
  },
)
test("lost start reply adopts native work and retry only queries recovery", async () => {
  const f = fixture()
  const start = f.ports.start
  f.ports.start = async (request) => {
    await start(request)
    throw new Error("bridge lost")
  }
  await f.provider.open({entryPoint: "settings"})
  await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
  expect(f.provider.snapshot().safeToRelease).toBe(false)
  f.emit({phase: "interrupted", canReconcile: true})
  await f.provider.perform({action: "retry"})
  expect(f.requests).toHaveLength(1)
  expect(f.releases()).toBe(0)
})
test("vendor force_update removes dismissal only from the approval prompt", async () => {
  const f = fixture()
  const lookup = f.ports.lookup
  f.ports.lookup = async (...args) => ({...(await lookup(...args)), forceUpdate: true})
  await f.provider.open({entryPoint: "settings"})
  expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).toEqual(["install"])
})
test("completion before the start promise settles remains visible and never starts twice", async () => {
  const f = fixture()
  const start = f.ports.start
  f.ports.start = async (request) => {
    await start(request)
    return f.emit({phase: "complete", safeToRelease: true})
  }
  await f.provider.open({entryPoint: "settings"})
  await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
  await f.provider.open({entryPoint: "recovery"})
  expect(f.provider.snapshot().phase).toBe("complete")
  expect(f.requests).toHaveLength(1)
})
