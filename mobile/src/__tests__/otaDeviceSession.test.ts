import {
  beginOtaAutoChain,
  isOtaAutoChainActive,
  otaAutoChainReleaseRange,
  stopOtaAutoChain,
} from "../../modules/engine/src/services/OtaAutoChain"
import {
  otaDeviceSessionRevision,
  startOtaDeviceSession,
  stopOtaDeviceSession,
} from "../../modules/engine/src/services/OtaDeviceSession"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {bluetoothSdkMock, emitBluetoothSdkEvent, resetBluetoothSdkMock} from "../test-utils/mockBluetoothSdk"

const pairA = {id: "A", address: "CC:E7:DE:E0:01:A4", model: "Mentra Live", name: "Mentra_Live_01A4"}
const pairB = {...pairA, id: "B", address: "CC:E7:DE:E0:01:B3", name: "Mentra_Live_01B3"}
const approve = () => beginOtaAutoChain("offer", true, {fromVersion: "3.3.0", toVersion: "3.2.1-beta.522"})

beforeEach(async () => {
  stopOtaDeviceSession()
  stopOtaAutoChain()
  resetBluetoothSdkMock()
  useGlassesStore.getState().reset()
  ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockResolvedValue(pairA)
  await startOtaDeviceSession()
})
afterEach(() => stopOtaDeviceSession())

it("clears a failed pair's approval, range, progress and MTK filtering when pairing changes", () => {
  approve()
  const store = useGlassesStore.getState()
  store.setOtaProgress({
    stage: "install",
    status: "FAILED",
    progress: 0,
    bytesDownloaded: 0,
    totalBytes: 0,
    currentUpdate: "apk",
  })
  store.setMtkUpdatedThisSession(true)
  emitBluetoothSdkEvent("default_device_changed", {device: pairB})
  expect(isOtaAutoChainActive()).toBe(false)
  expect(otaAutoChainReleaseRange()).toBeNull()
  expect(useGlassesStore.getState()).toMatchObject({
    otaProgress: null,
    otaStatus: null,
    otaUpdateAvailable: null,
    mtkUpdatedThisSession: false,
  })
})

it("preserves approval across same-pair disconnect/reboot and duplicate identity events", () => {
  approve()
  const revision = otaDeviceSessionRevision()
  useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
  emitBluetoothSdkEvent("default_device_changed", {device: {...pairA, address: pairA.address.toLowerCase(), rssi: -40}})
  useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}, buildNumber: "39"})
  expect(otaDeviceSessionRevision()).toBe(revision)
  expect(isOtaAutoChainActive()).toBe(true)
})

it("requires new approval after forgetting and selecting the same pair again", () => {
  approve()
  emitBluetoothSdkEvent("default_device_changed", {})
  emitBluetoothSdkEvent("default_device_changed", {device: pairA})
  expect(isOtaAutoChainActive()).toBe(false)
})

it("does not let initial hydration overwrite a newer pairing event", async () => {
  stopOtaDeviceSession()
  let resolve!: (device: unknown) => void
  ;(bluetoothSdkMock.getDefaultDevice as jest.Mock).mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    }),
  )
  const hydration = startOtaDeviceSession()
  emitBluetoothSdkEvent("default_device_changed", {device: pairB})
  approve()
  resolve(pairA)
  await hydration
  expect(isOtaAutoChainActive()).toBe(true)
})
