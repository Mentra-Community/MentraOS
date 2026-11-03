jest.mock("expo-router", () => ({usePathname: () => "/home"}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: jest.fn()})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
  dismissAlert: jest.fn(),
}))

import {act, render} from "@testing-library/react-native"
import type {GlassesAudioSetupState} from "@mentra/bluetooth-sdk"

import {BtClassicPairing} from "@/effects/BtClassicPairing"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"
import {SETTINGS, DeviceTypes} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"

const TITLE = "pairing:btClassicDisconnected"
const NEEDS_USER: GlassesAudioSetupState = {state: "needs_user", action: "connect_in_settings"}

const setAudioSetup = (audioSetup: GlassesAudioSetupState) =>
  act(() => useGlassesStore.getState().setGlassesInfo({audioSetup}))

describe("BtClassicPairing", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, DeviceTypes.LIVE, false)
    act(() => useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}}))
  })

  it("shows the prompt when the SDK says audio needs the user", () => {
    setAudioSetup(NEEDS_USER)
    render(<BtClassicPairing />)
    expect(showAlert).toHaveBeenCalledTimes(1)
    expect(showAlert).toHaveBeenCalledWith(TITLE, "pairing:btClassicDisconnectedMessage", expect.any(Array))
  })

  it.each(["idle", "not_applicable", "connecting", "connected"] as const)(
    "does not show the prompt while audio setup is %s",
    (state) => {
      setAudioSetup({state})
      render(<BtClassicPairing />)
      expect(showAlert).not.toHaveBeenCalled()
    },
  )

  it("shows the prompt once when connecting turns into needs_user", () => {
    setAudioSetup({state: "connecting"})
    render(<BtClassicPairing />)
    expect(showAlert).not.toHaveBeenCalled()

    setAudioSetup(NEEDS_USER)
    setAudioSetup(NEEDS_USER)
    expect(showAlert).toHaveBeenCalledTimes(1)
  })

  it("takes the prompt down when audio connects while it is showing", () => {
    setAudioSetup(NEEDS_USER)
    render(<BtClassicPairing />)
    expect(showAlert).toHaveBeenCalledTimes(1)

    setAudioSetup({state: "connected"})

    expect(dismissAlert).toHaveBeenCalledWith(TITLE)
  })

  it("takes the prompt down when the glasses disconnect while it is showing", () => {
    setAudioSetup(NEEDS_USER)
    render(<BtClassicPairing />)

    setAudioSetup({state: "idle"})

    expect(dismissAlert).toHaveBeenCalledWith(TITLE)
  })

  it("does not dismiss anything when no prompt was shown", () => {
    setAudioSetup({state: "connecting"})
    render(<BtClassicPairing />)
    setAudioSetup({state: "connected"})
    expect(dismissAlert).not.toHaveBeenCalled()
  })

  it("does not prompt for glasses other than Mentra Live", () => {
    useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, DeviceTypes.G2, false)
    setAudioSetup(NEEDS_USER)
    render(<BtClassicPairing />)
    expect(showAlert).not.toHaveBeenCalled()
  })
})
