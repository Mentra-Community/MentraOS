import {DeviceIntegrationRegistry} from "@/../modules/engine/src/devices/types"
import {MentraLiveFirmwareProvider} from "@/../modules/engine/src/devices/mentra-live/provider"
import {
  acquireManagedLiveOwner,
  recoverManagedLiveClock,
  validateManagedLiveTarget,
} from "@/../modules/engine/src/devices/mentra-live/ownership"
import {ota} from "@/../modules/engine/src/facades/ota"
import {FirmwareUpdateService} from "@/../modules/engine/src/ota/UpdateService"
import {deferStopForFirmware} from "@/../modules/engine/src/ota/RuntimeLease"
import {fixture, current} from "@/test-utils/liveOtaFixture"

describe("managed Live provider contract", () => {
  const target = {integrationId: "mentra-live", deviceId: "native-device-1", displayName: "Mentra Live"}
  let provider: MentraLiveFirmwareProvider
  let service: FirmwareUpdateService
  let f: ReturnType<typeof fixture>
  let safe: boolean
  let validate: jest.Mock<Promise<void>, []>

  beforeEach(() => {
    jest.useFakeTimers()
    f = fixture()
    safe = true
    validate = jest.fn(async () => {})
    service = new FirmwareUpdateService(
      new DeviceIntegrationRegistry([
        {
          id: target.integrationId,
          models: [target.displayName],
          firmware: {
            entryPoints: ["settings", "recovery"],
            createProvider: (value) => {
              provider = new MentraLiveFirmwareProvider(value, f.ports, validate, () => safe, acquireManagedLiveOwner)
              return provider
            },
          },
        },
      ]),
    )
  })
  afterEach(async () => {
    safe = true
    if (provider) {
      provider.suspendNewWork()
      await jest.advanceTimersByTimeAsync(0)
      service.release(target)
    }
    f.session.dispose()
    jest.useRealTimers()
  })

  const openOffer = async () => {
    await service.open(target, {entryPoint: "settings", initializeRuntime: false})
    await jest.advanceTimersByTimeAsync(1100)
    return provider.snapshot().offer!.id
  }

  it("observes without hardware commands and adopts duplicate starts and remounted views", async () => {
    const stop = service.subscribe(target, () => {})
    expect(validate).not.toHaveBeenCalled()
    expect(f.ports.installSession.attach).not.toHaveBeenCalled()
    const offerId = await openOffer()
    safe = false
    await Promise.all([
      service.perform(target, {action: "install", offerId}),
      service.perform(target, {action: "install", offerId}),
    ])
    expect(f.ports.installSession.prepare).toHaveBeenCalledTimes(1)
    expect(f.ports.installSession.attach).toHaveBeenCalledTimes(1)
    stop()
    const again = service.subscribe(target, () => {})
    await service.open(target, {entryPoint: "recovery", initializeRuntime: false})
    expect(f.ports.installSession.attach).toHaveBeenCalledTimes(1)
    expect(f.ports.installSession.detach).not.toHaveBeenCalled()
    expect(() => service.assertSafeToRelease()).toThrow("updating")
    again()
  })

  it("blocks competing legacy controls and keeps runtime inputs until the owner releases", async () => {
    await openOffer()
    const stopProjection = jest.fn()
    expect(deferStopForFirmware(stopProjection)).toBe(true)
    expect(() => ota.installSession.detach()).toThrow("managed Live")
    expect(() => ota.installSession.attach()).toThrow("managed Live")
    expect(() => ota.snapshot()).not.toThrow()
    service.release(target)
    expect(stopProjection).toHaveBeenCalledTimes(1)
  })

  it("revalidates native identity before a flash and exposes the same guard to coordinator retries", async () => {
    const offerId = await openOffer()
    validate.mockRejectedValue(new Error("different native device"))
    await expect(service.perform(target, {action: "install", offerId})).rejects.toThrow("different native device")
    await expect(validateManagedLiveTarget()).rejects.toThrow("different native device")
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
  })

  it("validates the native target again before resuming a retained provider", async () => {
    await openOffer()
    validate.mockRejectedValue(new Error("different native device"))
    await expect(service.open(target, {entryPoint: "recovery", initializeRuntime: false})).rejects.toThrow(
      "different native device",
    )
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
    expect(f.ports.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it("rechecks battery after asynchronous native identity validation", async () => {
    const offerId = await openOffer()
    let release!: () => void
    validate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const start = service.perform(target, {action: "install", offerId})
    await jest.advanceTimersByTimeAsync(0)
    f.device({batteryLevel: 5})
    // The session rechecks prerequisites at the actual install boundary.
    release()
    await start
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
    expect(provider.snapshot().phase).toBe("blocked")
  })

  it("keeps an uncertain failure unsafe and uses the coordinator for clock recovery", async () => {
    const offerId = await openOffer()
    safe = false
    await service.perform(target, {action: "install", offerId})
    f.install({displayState: "failed", errorMsg: "Timed out"})
    expect(provider.snapshot()).toMatchObject({phase: "failed", safeToRelease: false})
    expect(() => service.release(target)).toThrow("owns")
    expect(await recoverManagedLiveClock()).toBe(true)
    expect(f.ports.installSession.retry).toHaveBeenCalledTimes(1)
  })

  it("does not offer Done until pass teardown and the final release check finish", async () => {
    const offerId = await openOffer()
    await service.perform(target, {action: "install", offerId})
    f.install({displayState: "complete"})
    expect(provider.snapshot().phase).toBe("verifying")
    jest.mocked(f.ports.checkForUpdates).mockResolvedValue(current)
    await jest.advanceTimersByTimeAsync(1850)
    expect(provider.snapshot()).toMatchObject({phase: "complete", active: false, safeToRelease: true})
    expect(provider.snapshot().presentation.releaseNotes).toEqual([{version: "3.3.1", markdown: "Notes"}])
    expect(await service.perform(target, {action: "finish"})).toEqual({kind: "finished"})
  })

  it("stops new passes on auth/runtime teardown and releases inputs only once native work is safe", async () => {
    const offerId = await openOffer()
    safe = false
    await service.perform(target, {action: "install", offerId})
    const stopProjection = jest.fn()
    deferStopForFirmware(stopProjection)
    service.suspendNewWork()
    expect(provider.session.chain.isOtaAutoChainActive()).toBe(false)
    expect(provider.snapshot().safeToRelease).toBe(false)
    expect(stopProjection).not.toHaveBeenCalled()
    safe = true
    f.install({displayState: "complete"})
    expect(stopProjection).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(0)
    expect(f.ports.installSession.finish).toHaveBeenCalledTimes(1)
    expect(stopProjection).toHaveBeenCalledTimes(1)
    expect(provider.session.isDisposed).toBe(true)
    await jest.advanceTimersByTimeAsync(5000)
    expect(f.ports.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(provider.snapshot()).toMatchObject({phase: "complete", active: false, safeToRelease: true})
  })

  it("waits for suspended cleanup before reopening without restoring prior approval", async () => {
    const offerId = await openOffer()
    safe = false
    await service.perform(target, {action: "install", offerId})
    let finishCleanup!: () => void
    jest.mocked(f.ports.installSession.finish).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve
        }),
    )
    service.suspendNewWork()
    safe = true
    f.install({displayState: "complete"})
    await jest.advanceTimersByTimeAsync(0)
    let reopened = false
    const opening = service.open(target, {entryPoint: "recovery", initializeRuntime: false}).then(() => {
      reopened = true
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(reopened).toBe(false)
    expect(f.ports.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(provider.snapshot().safeToRelease).toBe(false)
    finishCleanup()
    await opening
    expect(reopened).toBe(true)
    expect(provider.session.isDisposed).toBe(false)
    expect(provider.session.chain.isOtaAutoChainActive()).toBe(false)
    expect(f.ports.installSession.prepare).toHaveBeenCalledTimes(1)
  })

  it("cannot start after the host stops during target validation", async () => {
    const offerId = await openOffer()
    let resume!: () => void
    validate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    const start = service.perform(target, {action: "install", offerId})
    const failed = expect(start).rejects.toThrow("runtime stopped")
    await jest.advanceTimersByTimeAsync(0)
    service.suspendNewWork()
    resume()
    await failed
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
  })

  it("can explicitly reopen a retained terminal provider without restoring old chain approval", async () => {
    await openOffer()
    service.suspendNewWork()
    expect(provider.session.isDisposed).toBe(true)
    await service.open(target, {entryPoint: "settings", initializeRuntime: false})
    await jest.advanceTimersByTimeAsync(1100)
    expect(provider.session.isDisposed).toBe(false)
    expect(provider.snapshot().phase).toBe("available")
    expect(provider.session.chain.isOtaAutoChainActive()).toBe(false)
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
  })

  it("rechecks an offer after observed firmware or connection generation changes", async () => {
    const offerId = await openOffer()
    f.device({buildNumber: "33000002"})
    await service.perform(target, {action: "install", offerId})
    expect(f.ports.installSession.prepare).not.toHaveBeenCalled()
    expect(f.ports.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(provider.snapshot().phase).toBe("checking")
  })
})
