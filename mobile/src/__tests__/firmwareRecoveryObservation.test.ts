import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {observeNativeRecovery} from "@/../modules/engine/src/ota/observeNativeRecovery"
import {bluetoothSdkMock, emitBluetoothSdkEvent} from "@/test-utils/mockBluetoothSdk"

const state: NativeFirmwareUpdateSnapshot = {
  schemaVersion: 1,
  updaterId: "native-updater",
  integrationId: "nimo",
  deviceId: "native-device",
  connectionGeneration: 1,
  revision: 2,
  sessionId: "cold-session",
  phase: "interrupted",
  safeToRelease: false,
  canCancel: false,
  canReconcile: false,
  inventory: {},
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe("local firmware recovery observation", () => {
  beforeEach(() => {
    bluetoothSdkMock.getDefaultDevice.mockReturnValue({id: state.deviceId, model: "NIMO"} as never)
    bluetoothSdkMock.getFirmwareUpdateSnapshot.mockResolvedValue(state as never)
    bluetoothSdkMock.startOtaUpdate.mockClear()
    bluetoothSdkMock.queryOtaStatus.mockClear()
    bluetoothSdkMock.connectDefault.mockClear()
  })

  it("reads retained native work before authentication without checking releases or starting a command", async () => {
    const observed: (NativeFirmwareUpdateSnapshot | null)[] = []
    const stop = observeNativeRecovery((value) => observed.push(value))
    await flush()
    expect(observed.at(-1)).toEqual(state)
    emitBluetoothSdkEvent("firmware_update", {...state, revision: 3, phase: "complete", safeToRelease: true})
    emitBluetoothSdkEvent("firmware_update", state)
    expect(observed.at(-1)).toMatchObject({revision: 3, safeToRelease: true})
    stop()
    const count = observed.length
    emitBluetoothSdkEvent("firmware_update", {...state, revision: 4})
    expect(observed).toHaveLength(count)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.connectDefault).not.toHaveBeenCalled()
  })

  it("does not publish a late native read after the recovery surface unmounts", async () => {
    let resolve!: (value: NativeFirmwareUpdateSnapshot) => void
    bluetoothSdkMock.getFirmwareUpdateSnapshot.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }) as never,
    )
    const listener = jest.fn()
    const stop = observeNativeRecovery(listener)
    await flush()
    stop()
    listener.mockClear()
    resolve(state)
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })
})
