jest.mock("expo-router", () => ({usePathname: () => "/home"}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: jest.fn()})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
  dismissAlert: jest.fn(),
}))

import {act, render} from "@testing-library/react-native"
import {Platform} from "react-native"

import {BtClassicPairing} from "@/effects/BtClassicPairing"
import {AUDIO_RECONNECT_GRACE_MS} from "@/utils/pairing/pairAudio"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"
import {SETTINGS, DeviceTypes} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"

const TITLE = "pairing:btClassicDisconnected"

const connect = () =>
  act(() => useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}}))

describe("BtClassicPairing", () => {
  const originalOS = Platform.OS

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    ;(Platform as {OS: string}).OS = "ios"
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, DeviceTypes.LIVE, false)
  })

  afterEach(() => {
    jest.useRealTimers()
    ;(Platform as {OS: string}).OS = originalOS
  })

  it("shows the prompt when the link is up and audio stays down", () => {
    connect()
    render(<BtClassicPairing />)
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS))
    expect(showAlert).toHaveBeenCalledWith(TITLE, "pairing:btClassicDisconnectedMessage", expect.any(Array))
  })

  it("does not show the prompt when audio comes up inside the grace period", () => {
    connect()
    render(<BtClassicPairing />)
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS - 1000))
    act(() => useGlassesStore.getState().setGlassesInfo({bluetoothAudioRouted: true}))
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS))
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("does not show the prompt when the audio route is already active", () => {
    connect()
    act(() => useGlassesStore.getState().setGlassesInfo({bluetoothAudioRouted: true}))
    render(<BtClassicPairing />)
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS))
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("takes the prompt down when audio comes up while it is showing", () => {
    connect()
    render(<BtClassicPairing />)
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS))
    expect(showAlert).toHaveBeenCalledTimes(1)

    act(() => useGlassesStore.getState().setGlassesInfo({bluetoothAudioRouted: true}))

    expect(dismissAlert).toHaveBeenCalledWith(TITLE)
  })

  it("takes the prompt down when the glasses disconnect while it is showing", () => {
    connect()
    render(<BtClassicPairing />)
    act(() => jest.advanceTimersByTime(AUDIO_RECONNECT_GRACE_MS))

    act(() => useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}}))

    expect(dismissAlert).toHaveBeenCalledWith(TITLE)
  })

  it("does not dismiss anything when no prompt was shown", () => {
    connect()
    render(<BtClassicPairing />)
    act(() => useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true}))
    expect(dismissAlert).not.toHaveBeenCalled()
  })
})
