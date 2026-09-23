import {describe, expect, test} from "bun:test"
import type {NativeFirmwareStartRequest, NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {NimoFirmwareProvider, type NimoFirmwarePorts} from "../provider"
import {parseNimoManifest} from "../manifest"
import {DeviceIntegrationRegistry} from "../../types"
import {FirmwareUpdateService} from "../../../ota/UpdateService"

const target = {integrationId: "nimo", deviceId: "native-device", displayName: "NIMO"}
const fullVersion = "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"
const manifest = parseNimoManifest({
  schemaVersion: 1,
  releaseId: "test",
  hardwareId: "00000201",
  target: {fullVersion, packedVersion: "0.1.1.1", peerVersion: "0001"},
  compatible: [{fullVersion, packedVersion: "0.1.1.1"}],
  upgradeFrom: ["0.1.0.14"],
  artifact: {url: "https://example.invalid/image", size: 1857523, sha256: "a".repeat(64)},
})

function fixture() {
  let native: NativeFirmwareUpdateSnapshot = {
    ...target,
    schemaVersion: 1,
    updaterId: "native-updater",
    revision: 0,
    connectionGeneration: 1,
    phase: "idle",
    safeToRelease: true,
    canCancel: false,
    canReconcile: false,
    observedFirmware: "FW-VERSION-v0.1.0.14-old",
    inventory: {packedVersion: "0.1.0.14"},
  }
  const listeners = new Set<(value: NativeFirmwareUpdateSnapshot) => void>()
  const requests: NativeFirmwareStartRequest[] = []
  let releases = 0
  let held = 0
  let ids = 0
  const emit = (patch: Partial<NativeFirmwareUpdateSnapshot>) => {
    native = {...native, ...patch, revision: native.revision + 1}
    for (const listener of listeners) listener(native)
    return native
  }
  const ports: NimoFirmwarePorts = {
    read: async () => native,
    listen: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    validateTarget: async () => {},
    refreshInventory: async () => native,
    reconcile: async () => native,
    start: async (request) => {
      requests.push(request)
      return emit({sessionId: "native-session", offerId: request.offerId, phase: "preparing", safeToRelease: false})
    },
    acknowledge: async () => emit({sessionId: undefined, offerId: undefined, phase: "idle"}),
    source: () => ({url: "https://example.invalid/manifest", sha256: "b".repeat(64)}),
    loadManifest: async () => manifest,
    configureCompatibility: async () => {},
    compatible: manifest.compatible,
    stage: async () => ({
      path: "/staged/image.bin",
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
  const provider = new NimoFirmwareProvider(target, ports)
  return {ports, provider, emit, requests, releases: () => releases, held: () => held}
}

describe("headless NIMO firmware policy", () => {
  test.each(["event", "reopen", "retry"])(
    "%s resolves failed admission without bypassing required setup",
    async (via) => {
      const f = fixture()
      const service = new FirmwareUpdateService(
        new DeviceIntegrationRegistry([
          {
            id: "nimo",
            models: ["NIMO"],
            firmware: {entryPoints: ["pairing"], createProvider: () => f.provider},
          },
        ]),
      )
      const read = f.ports.read
      let starts = 0
      f.ports.start = async () => {
        starts++
        f.ports.read = async () => {
          f.ports.read = read
          throw new Error("Status reply lost")
        }
        throw new Error("Start failed before admission")
      }
      await service.open(target, {entryPoint: "pairing"})
      await service.perform(target, {action: "install", offerId: f.provider.snapshot().offer!.id})
      expect(f.provider.snapshot()).toMatchObject({phase: "interrupted", safeToRelease: false})
      expect(f.held()).toBe(1)
      expect(f.releases()).toBe(0)
      expect(() => service.assertSafeToRelease()).toThrow()
      if (via === "event") f.emit({phase: "idle", safeToRelease: true})
      if (via === "retry") {
        f.ports.read = async () => {
          throw new Error("Still disconnected")
        }
        await expect(service.perform(target, {action: "retry"})).rejects.toThrow("Still disconnected")
        expect(f.provider.snapshot().safeToRelease).toBe(false)
        expect(f.held()).toBe(1)
        f.ports.read = read
        await service.perform(target, {action: "retry"})
      }
      // A rejected Start may leave the native snapshot at the same revision.
      await service.open(target, {entryPoint: "pairing"})
      expect(f.provider.snapshot()).toMatchObject({phase: "idle", safeToRelease: true, active: false, offer: null})
      expect(f.provider.snapshot().presentation.success).toBe(false)
      expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).toEqual(["check", "discard"])
      expect(() => service.assertSafeToRelease()).not.toThrow()
      expect(f.held()).toBe(0)
      expect(f.releases()).toBe(1)
      expect(starts).toBe(1)
      expect(await service.perform(target, {action: "discard"})).toEqual({kind: "finished", outcome: "cancelled"})
    },
  )

  test("checks, binds approval to the source and device, and follows native completion", async () => {
    const f = fixture()
    await f.provider.open({entryPoint: "pairing"})
    expect(f.provider.snapshot().offer?.required).toBe(true)
    expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).toEqual(["install", "discard"])
    await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.metadata.peerVersion).toBe("0001")
    expect(f.held()).toBe(1)
    f.emit({phase: "transferring", progress: 0.5})
    expect(f.provider.snapshot().phase).toBe("installing")
    expect(f.provider.snapshot().presentation.progress).toBe(50)
    f.emit({phase: "validating"})
    expect(f.provider.snapshot().phase).toBe("verifying")
    f.emit({phase: "complete", safeToRelease: true, observedFirmware: fullVersion})
    expect(f.provider.snapshot().phase).toBe("complete")
    expect(f.held()).toBe(0)
    expect(await f.provider.perform({action: "finish"})).toEqual({kind: "finished"})
    expect(f.releases()).toBe(1)
  })

  test("already-compatible firmware works offline without a remote source", async () => {
    const f = fixture()
    f.ports.source = () => null
    f.emit({observedFirmware: fullVersion, inventory: {packedVersion: "0.1.1.1"}})
    await f.provider.open({entryPoint: "pairing"})
    expect(f.provider.snapshot().phase).toBe("complete")
    expect(f.requests).toHaveLength(0)
  })

  test("fresh native inventory can recognize cached verified compatibility while offline", async () => {
    const f = fixture()
    f.ports.source = () => null
    f.emit({
      observedFirmware: "FW-VERSION-v0.1.2.0-approved",
      inventory: {packedVersion: "0.1.2.0", compatible: "true"},
    })
    await f.provider.open({entryPoint: "pairing"})
    expect(f.provider.snapshot().phase).toBe("complete")
    expect(f.requests).toHaveLength(0)
  })

  test("unknown newer firmware is blocked without a downgrade or pairing bypass", async () => {
    const f = fixture()
    f.emit({observedFirmware: "FW-VERSION-v0.2.0.0-unknown", inventory: {packedVersion: "0.2.0.0"}})
    await f.provider.open({entryPoint: "pairing"})
    expect(f.provider.snapshot().phase).toBe("blocked")
    expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).toEqual(["check", "discard"])
  })

  test.each(["no-source", "unknown-version", "failed-check"])(
    "%s can leave setup without bypassing compatibility",
    async (reason) => {
      const f = fixture()
      if (reason === "no-source") f.ports.source = () => null
      if (reason === "unknown-version")
        f.emit({observedFirmware: "FW-VERSION-v0.2.0.0-unknown", inventory: {packedVersion: "0.2.0.0"}})
      if (reason === "failed-check")
        f.ports.refreshInventory = async () => {
          throw new Error("inventory unavailable")
        }
      await f.provider.open({entryPoint: "pairing"})
      expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).toContain("discard")
      expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).not.toContain("finish")
      expect(await f.provider.perform({action: "discard"})).toEqual({kind: "finished", outcome: "cancelled"})
      expect(f.requests).toHaveLength(0)
      expect(f.provider.snapshot().presentation.success).toBe(false)
    },
  )

  test("cannot cancel setup while a native transaction requires recovery", async () => {
    const f = fixture()
    f.emit({phase: "interrupted", sessionId: "retained", safeToRelease: false, canReconcile: true})
    await f.provider.open({entryPoint: "pairing"})
    expect(f.provider.snapshot().presentation.actions.map((action) => action.id)).not.toContain("discard")
    await expect(f.provider.perform({action: "discard"})).rejects.toThrow("recovery")
  })

  test("reopening observes the existing native session without checking or starting another", async () => {
    const f = fixture()
    f.emit({phase: "transferring", sessionId: "retained", safeToRelease: false})
    f.ports.loadManifest = async () => {
      throw new Error("should not fetch")
    }
    await f.provider.open({entryPoint: "settings"})
    await f.provider.open({entryPoint: "recovery"})
    expect(f.provider.snapshot().nativeSessionId).toBe("retained")
    expect(f.provider.snapshot().phase).toBe("installing")
    expect(f.requests).toHaveLength(0)
  })

  test.each(["source", "device", "firmware"])("%s change during download invalidates approval", async (change) => {
    const f = fixture()
    await f.provider.open({entryPoint: "settings"})
    let done!: () => void
    const gate = new Promise<void>((resolve) => {
      done = resolve
    })
    const stage = f.ports.stage
    f.ports.stage = async (...args) => {
      await gate
      return stage(...args)
    }
    const installing = f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    if (change === "source") f.ports.source = () => null
    else if (change === "device") f.emit({connectionGeneration: 2})
    else f.emit({observedFirmware: fullVersion})
    done()
    await installing
    expect(f.requests).toHaveLength(0)
    expect(f.releases()).toBe(1)
    expect(f.provider.snapshot().phase).toBe("failed")
  })

  test("runtime teardown during download cleans its file without starting firmware", async () => {
    const f = fixture()
    await f.provider.open({entryPoint: "settings"})
    const stage = f.ports.stage
    f.ports.stage = async (...args) => {
      f.provider.suspendNewWork()
      return stage(...args)
    }
    await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
    expect(f.requests).toHaveLength(0)
    expect(f.releases()).toBe(1)
    expect(f.provider.snapshot().phase).toBe("idle")
  })

  test("a lost bridge response adopts native admission, with no reset or second start", async () => {
    const f = fixture()
    const start = f.ports.start
    f.ports.start = async (request) => {
      await start(request)
      throw new Error("bridge lost")
    }
    await f.provider.open({entryPoint: "settings"})
    await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
    expect(f.provider.snapshot().safeToRelease).toBe(false)
    expect(f.requests).toHaveLength(1)
    f.emit({phase: "interrupted", canReconcile: false})
    expect(f.provider.snapshot().presentation.actions).toEqual([])
    await expect(f.provider.perform({action: "retry"})).rejects.toThrow("No verified recovery")
    expect(f.held()).toBe(1)
  })

  test("native admission during a compatibility check cannot be overwritten by a safe check failure", async () => {
    const f = fixture()
    f.ports.configureCompatibility = async () => {
      f.emit({sessionId: "native-other-caller", phase: "preparing", safeToRelease: false})
      throw new Error("Native update owns its policy")
    }
    await f.provider.open({entryPoint: "settings"})
    expect(f.provider.snapshot().nativeSessionId).toBe("native-other-caller")
    expect(f.provider.snapshot().safeToRelease).toBe(false)
    expect(f.provider.snapshot().phase).toBe("preparing")
    expect(f.requests).toHaveLength(0)
  })
})

test("an older idle read cannot release newer native admission after a lost Start reply", async () => {
  const f = fixture()
  await f.provider.open({entryPoint: "settings"})
  const idle = await f.ports.read()
  const start = f.ports.start
  f.ports.start = async (request) => {
    await start(request)
    f.ports.read = async () => idle
    throw new Error("Start reply lost after native admission")
  }
  await f.provider.perform({action: "install", offerId: f.provider.snapshot().offer!.id})
  expect(f.requests).toHaveLength(1)
  expect(f.provider.snapshot()).toMatchObject({active: true, safeToRelease: false, phase: "preparing"})
  expect(f.provider.snapshot().nativeSessionId).toBeTruthy()
  expect(f.provider.snapshot().presentation.actions).toEqual([])
  expect(f.held()).toBe(1)
  expect(f.releases()).toBe(0)
  await expect(f.provider.perform({action: "finish"})).rejects.toThrow()
  f.emit({phase: "complete", safeToRelease: true})
  expect(f.held()).toBe(0)
  expect(f.releases()).toBe(1)
})
