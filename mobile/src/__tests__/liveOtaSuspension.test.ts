import {otaServer} from "@mentra/bluetooth-sdk/ota-transport"
import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {MentraLiveFirmwareProvider} from "@/../modules/engine/src/devices/mentra-live/provider"
import {liveOtaPorts} from "@/../modules/engine/src/devices/mentra-live/ports"
import {acquireManagedLiveOwner} from "@/../modules/engine/src/devices/mentra-live/ownership"
import {DeviceIntegrationRegistry} from "@/../modules/engine/src/devices/types"
import {FirmwareUpdateService} from "@/../modules/engine/src/ota/UpdateService"
import {deferStopForFirmware} from "@/../modules/engine/src/ota/RuntimeLease"
import {acquireGlassesHotspot} from "@/../modules/engine/src/services/GlassesHotspotLease"
import {hotspotOtaTransport} from "@/../modules/engine/src/services/HotspotOtaTransport"
import {otaInstallCoordinator} from "@/../modules/engine/src/services/OtaInstallCoordinator"
import {cleanupArtifacts, type OtaArtifactPlanEntry} from "@/../modules/engine/src/services/OtaArtifactDownloader"
import {localNetworkTransport} from "@/../modules/engine/src/services/asg/localNetworkTransport"
import {useGlassesStore} from "@/../modules/engine/src/stores/glasses"
import {offer} from "@/test-utils/liveOtaFixture"
import {bluetoothSdkMock, emitBluetoothSdkEvent} from "@/test-utils/mockBluetoothSdk"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  const {isEnabledHotspotStatus} = jest.requireActual("@/../modules/bluetooth-sdk/src/BluetoothSdk.types")
  return {__esModule: true, default: bluetoothSdkMock, ...bluetoothSdkMock, isEnabledHotspotStatus}
})
jest.mock("@/../modules/engine/src/services/asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    connect: jest.fn(async () => "127.0.0.1"),
    disconnect: jest.fn(async () => {}),
  },
}))
jest.mock("@/../modules/engine/src/services/OtaArtifactDownloader", () => {
  const real = jest.requireActual("@/../modules/engine/src/services/OtaArtifactDownloader")
  return {
    ...real,
    prepareArtifacts: jest.fn(async (entries: OtaArtifactPlanEntry[]) =>
      entries.map((entry) => ({...entry, filePath: "/test/firmware.apk"})),
    ),
    cleanupArtifacts: jest.fn(async () => {}),
  }
})

const target = {integrationId: "mentra-live", deviceId: "live", displayName: "Mentra Live"}
const update = {
  ...offer,
  manifestBody: JSON.stringify({
    bes_firmware: {url: "https://example.com/bes.bin", sha256: "b".repeat(64), version: "new"},
    apps: {
      "com.mentra.asg_client": {
        apkUrl: "https://example.com/firmware.apk",
        sha256: "a".repeat(64),
        versionCode: 33010001,
      },
    },
  }),
}

/** Real provider, session, coordinator and hotspot transport; only device/network/file I/O is mocked. */
describe("Live suspended hotspot cleanup", () => {
  let native: NativeFirmwareUpdateSnapshot
  let provider: MentraLiveFirmwareProvider
  let service: FirmwareUpdateService
  let failFinishRead: boolean
  let useBesProof: boolean
  let observationOnly: boolean
  let stopServer: (() => void) | undefined
  let check: jest.Mock
  const read = bluetoothSdkMock.getFirmwareUpdateSnapshot as jest.Mock
  const serverStop = otaServer.stop as jest.Mock

  beforeEach(() => {
    jest.useFakeTimers()
    otaInstallCoordinator.detach()
    useGlassesStore.getState().reset()
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "33000001",
      appVersion: "3.3.0",
      batteryLevel: 80,
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    native = {
      schemaVersion: 1,
      integrationId: "mentra-live",
      deviceId: "live",
      updaterId: "updater",
      revision: 0,
      connectionGeneration: 1,
      phase: "idle",
      safeToRelease: true,
      canCancel: false,
      canReconcile: false,
      inventory: {},
    }
    failFinishRead = false
    useBesProof = false
    observationOnly = false
    stopServer = undefined
    read.mockImplementation(async () => {
      if (failFinishRead) throw new Error("Completion read unavailable")
      return native
    })
    bluetoothSdkMock.startOtaUpdate.mockReset().mockImplementation(async () => {
      native = {...native, revision: 1, sessionId: "install", phase: "installing", safeToRelease: false}
      emitBluetoothSdkEvent("firmware_update", native)
    })
    bluetoothSdkMock.reconcileFirmwareUpdateCompletion.mockReset().mockImplementation(async (evidence) => {
      expect(evidence.kind).toBe("live-bes-reboot")
      native = {...native, revision: native.revision + 1, phase: "complete", safeToRelease: true}
      emitBluetoothSdkEvent("firmware_update", native)
      return native
    })
    serverStop.mockReset().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          stopServer = resolve
        }),
    )
    jest.mocked(cleanupArtifacts).mockClear()
    jest.mocked(localNetworkTransport.disconnect).mockClear()
    check = jest.fn(async () => {
      const result = useBesProof
        ? {...update, updates: ["bes" as const], updateInfo: {...update.updateInfo!, updates: ["bes" as const]}}
        : update
      useGlassesStore.getState().setOtaUpdateAvailable(result.updateInfo)
      return result
    })
    service = new FirmwareUpdateService(
      new DeviceIntegrationRegistry([
        {
          id: "mentra-live",
          models: ["Mentra Live"],
          firmware: {
            entryPoints: ["settings", "recovery"],
            createProvider: (value) => {
              provider = new MentraLiveFirmwareProvider(
                value,
                {...liveOtaPorts, checkForUpdates: check},
                async () => {},
                () => otaInstallCoordinator.isSafeToRelease(),
                (validate, retry) => acquireManagedLiveOwner(validate, retry, "live"),
                async () => observationOnly,
              )
              return provider
            },
          },
        },
      ]),
    )
  })

  afterEach(async () => {
    failFinishRead = false
    serverStop.mockResolvedValue(undefined)
    stopServer?.()
    const cleanup = hotspotOtaTransport.teardown()
    await jest.advanceTimersByTimeAsync(1000)
    await cleanup
    if (provider && !provider.session.isDisposed) {
      native = {...native, revision: native.revision + 1, phase: "complete", safeToRelease: true}
      emitBluetoothSdkEvent("firmware_update", native)
      provider.session.resumeNewWork()
      const finish = provider.session.finish()
      await jest.advanceTimersByTimeAsync(1000)
      await finish
      provider.suspendNewWork()
      await jest.advanceTimersByTimeAsync(0)
    }
    service?.release(target)
    otaInstallCoordinator.detach()
    read.mockReset().mockRejectedValue(Object.assign(new Error("No native updater"), {code: "unsupported"}))
    jest.useRealTimers()
  })

  it("finishes observation-only idle recovery before offering an explicit new install", async () => {
    observationOnly = true
    native = {...native, revision: 1, sessionId: "recovered", phase: "interrupted", safeToRelease: false}
    useGlassesStore.getState().setOtaStatus({
      sessionId: "recovered",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "download",
      stepPercent: 0,
      overallPercent: 0,
      status: "in_progress",
    })
    await service.open(target, {entryPoint: "recovery", initializeRuntime: false})
    expect(check).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    native = {...native, revision: 2, phase: "idle", sessionId: undefined, safeToRelease: true}
    emitBluetoothSdkEvent("firmware_update", native)
    useGlassesStore.getState().setOtaStatus({
      sessionId: "",
      totalSteps: 0,
      currentStep: 0,
      stepType: "apk",
      phase: "download",
      stepPercent: 0,
      overallPercent: 0,
      status: "idle",
    })
    await jest.advanceTimersByTimeAsync(1100)
    expect(provider.session.requiresCleanup).toBe(false)
    expect(provider.snapshot()).toMatchObject({active: false, phase: "available"})
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    await service.perform(target, {action: "install", offerId: provider.snapshot().offer!.id})
    await jest.advanceTimersByTimeAsync(0)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("keeps an open progress host attached if native becomes unsafe during cleanup", async () => {
    await service.open(target, {entryPoint: "settings", initializeRuntime: false})
    await jest.advanceTimersByTimeAsync(1100)
    await service.perform(target, {action: "install", offerId: provider.snapshot().offer!.id})
    await jest.advanceTimersByTimeAsync(0)
    provider.session.chain.stopOtaAutoChain()
    native = {...native, revision: 2, phase: "complete", safeToRelease: true}
    emitBluetoothSdkEvent("firmware_update", native)
    useGlassesStore.getState().setOtaStatus({
      sessionId: "install",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "install",
      stepPercent: 100,
      overallPercent: 100,
      status: "complete",
    })
    const finished = Promise.resolve(provider.session.finish()).then(
      () => null,
      (error) => error,
    )
    await jest.advanceTimersByTimeAsync(1000)
    native = {...native, revision: 3, phase: "installing", safeToRelease: false}
    emitBluetoothSdkEvent("firmware_update", native)
    stopServer!()
    await jest.advanceTimersByTimeAsync(0)
    expect(await finished).toBeInstanceOf(Error)
    expect(provider.session.snapshot().page).toBe("progress")
    expect(provider.snapshot().safeToRelease).toBe(false)
    expect(() => service.release(target)).toThrow("owns")
    expect(check).toHaveBeenCalledTimes(1)

    native = {...native, revision: 4, phase: "complete", safeToRelease: true}
    emitBluetoothSdkEvent("firmware_update", native)
    await service.perform(target, {action: "retry"})
    await jest.advanceTimersByTimeAsync(1100)
    expect(provider.session.snapshot().page).toBe("check")
    expect(check).toHaveBeenCalledTimes(2)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it.each([
    {failRead: false, legacy: false, late: "none"},
    {failRead: true, legacy: false, late: "none"},
    {failRead: false, legacy: true, late: "none"},
    {failRead: false, legacy: false, late: "ble"},
    {failRead: false, legacy: false, late: "native"},
  ])(
    "retains resources through terminal cleanup (read failure=$failRead, legacy BES=$legacy, late=$late)",
    async ({failRead, legacy, late}) => {
      useBesProof = legacy
      await service.open(target, {entryPoint: "settings", initializeRuntime: false})
      await jest.advanceTimersByTimeAsync(1100)
      await service.perform(target, {action: "install", offerId: provider.snapshot().offer!.id})
      await jest.advanceTimersByTimeAsync(0)
      expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
      expect(otaServer.start).toHaveBeenCalled()
      expect(() => acquireGlassesHotspot()).toThrow("already in use")
      const stopped = jest.fn()
      expect(deferStopForFirmware(stopped)).toBe(true)
      service.suspendNewWork()
      failFinishRead = failRead
      if (legacy) {
        useGlassesStore.getState().setOtaStatus({
          sessionId: "install",
          totalSteps: 1,
          currentStep: 1,
          stepType: "bes",
          phase: "install",
          stepPercent: 100,
          overallPercent: 100,
          status: "step_complete",
        })
        useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
        native = {...native, revision: 2, connectionGeneration: 2, phase: "interrupted"}
        emitBluetoothSdkEvent("firmware_update", native)
        useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
        expect(native.safeToRelease).toBe(false)
      } else {
        native = {...native, revision: 2, phase: "complete", safeToRelease: true}
        // Session store observation runs before the coordinator sees this terminal event.
        emitBluetoothSdkEvent("firmware_update", native)
        useGlassesStore.getState().setOtaStatus({
          sessionId: "install",
          totalSteps: 1,
          currentStep: 1,
          stepType: "apk",
          phase: "install",
          stepPercent: 100,
          overallPercent: 100,
          status: "complete",
        })
      }
      expect(provider.snapshot().safeToRelease).toBe(false)
      expect(() => service.release(target)).toThrow("owns")
      expect(stopped).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1000)
      if (failRead) {
        expect(provider.session.isDisposed).toBe(false)
        expect(provider.snapshot().safeToRelease).toBe(false)
        expect(check).toHaveBeenCalledTimes(1)
        failFinishRead = false
        await service.open(target, {entryPoint: "recovery", initializeRuntime: false})
        await service.perform(target, {action: "retry"})
        await jest.advanceTimersByTimeAsync(1000)
        service.suspendNewWork()
      }
      if (legacy) expect(bluetoothSdkMock.reconcileFirmwareUpdateCompletion).toHaveBeenCalledTimes(1)
      expect(serverStop).toHaveBeenCalledTimes(1)
      expect(stopped).not.toHaveBeenCalled()
      expect(() => acquireGlassesHotspot()).toThrow("already in use")
      expect(localNetworkTransport.disconnect).not.toHaveBeenCalled()
      if (late === "ble") {
        useGlassesStore.getState().setOtaStatus({
          sessionId: "install",
          totalSteps: 1,
          currentStep: 1,
          stepType: "apk",
          phase: "download",
          stepPercent: 5,
          overallPercent: 5,
          status: "in_progress",
        })
        useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
        useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      } else if (late === "native") {
        native = {...native, revision: native.revision + 1, phase: "installing", safeToRelease: false}
        emitBluetoothSdkEvent("firmware_update", native)
      }
      stopServer!()
      await jest.advanceTimersByTimeAsync(0)
      expect(localNetworkTransport.disconnect).toHaveBeenCalledTimes(1)
      expect(cleanupArtifacts).toHaveBeenCalledTimes(1)
      if (late === "native") {
        expect(stopped).not.toHaveBeenCalled()
        expect(provider.snapshot().safeToRelease).toBe(false)
        native = {...native, revision: native.revision + 1, phase: "complete", safeToRelease: true}
        emitBluetoothSdkEvent("firmware_update", native)
        await jest.advanceTimersByTimeAsync(0)
      }
      expect(stopped).toHaveBeenCalledTimes(1)
      expect(provider.session.isDisposed).toBe(true)
      expect(provider.snapshot().safeToRelease).toBe(true)
      expect(otaInstallCoordinator.isSafeToRelease()).toBe(true)
      const release = acquireGlassesHotspot()
      release()
      expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
      expect(check).toHaveBeenCalledTimes(1)
    },
  )
})
