import {expect, mock, test} from "bun:test"

let safe = true
let attached = false
let runtimeLeases = 0
let prepareError: Error | null = null
let checkResult: Promise<void> = Promise.resolve()
mock.module("../../../ota/RuntimeLease", () => ({
  acquireFirmwareRuntime: () => {
    runtimeLeases++
    return () => {
      runtimeLeases--
    }
  },
}))
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    getDefaultDevice: async () => ({id: "legacy-live", model: "Mentra Live"}),
  },
}))
mock.module("../../../services/OtaInstallCoordinator", () => ({
  otaInstallCoordinator: {isSafeToRelease: () => safe, cancelUnboundPreparation: () => false},
}))
mock.module("../ports", () => ({
  liveOtaPorts: {
    checkForUpdates: () => checkResult,
    installSession: {
      prepare: () => {
        if (prepareError) throw prepareError
        return "wifi"
      },
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
      },
      retry: () => {},
      finish: async () => {
        safe = true
      },
      discard: async () => {
        safe = true
      },
    },
  },
}))
const {ota} = await import("../../../facades/ota")
const {acquireManagedLiveOwner, managedLiveDeviceId, validateManagedLiveTarget} = await import("../ownership")
const managed = () =>
  acquireManagedLiveOwner(
    async () => {},
    () => {},
    "managed-live",
  )

test("both Live interfaces reserve the controller before the other can attach", async () => {
  ota.installSession.attach()
  expect(attached).toBe(true)
  expect(() => managed()).toThrow("already owns")
  await validateManagedLiveTarget()
  expect(managedLiveDeviceId()).toBe("legacy-live")
  ota.installSession.retry()
  ota.installSession.detach()
  expect(attached).toBe(false)
  expect(runtimeLeases).toBe(0)
  const release = managed()
  expect(() => ota.installSession.attach()).toThrow("managed Live")
  expect(() => ota.installSession.prepare({} as never)).toThrow("managed Live")
  release()
  expect(runtimeLeases).toBe(0)
})

test("legacy unsafe unmount retains its controller and is honored after terminal cleanup", async () => {
  ota.installSession.attach()
  safe = false
  ota.installSession.detach()
  expect(attached).toBe(true)
  expect(() => managed()).toThrow("already owns")
  await ota.installSession.finish()
  expect(attached).toBe(false)
  const release = managed()
  release()
  expect(runtimeLeases).toBe(0)
})

test("legacy preparation and pending checks reserve execution without leaking short-lived controls", async () => {
  expect(ota.installSession.prepare({} as never)).toBe("wifi")
  expect(() => managed()).toThrow("already owns")
  ota.installSession.detach()
  let finishCheck!: () => void
  checkResult = new Promise((resolve) => {
    finishCheck = resolve
  })
  const checking = ota.checkForUpdates()
  expect(() => managed()).toThrow("already owns")
  finishCheck()
  await checking
  const release = managed()
  release()
  expect(runtimeLeases).toBe(0)
})

test("a failed legacy preparation does not retain an unattached controller", () => {
  prepareError = new Error("Glasses Wi-Fi status is not available")
  expect(() => ota.installSession.prepare({} as never)).toThrow("Wi-Fi status")
  expect(runtimeLeases).toBe(0)
  const release = managed()
  release()
  prepareError = null
})
