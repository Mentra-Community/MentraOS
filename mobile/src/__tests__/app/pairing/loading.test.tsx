jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@react-navigation/native", () => ({
  useRoute: jest.fn(),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/services/bugReport/automaticBugReport", () => ({
  submitAutomaticBugIncident: jest.fn(() => Promise.resolve({status: "filed", incidentId: "inc-1"})),
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  function MockHeader() {
    return <View />
  }
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  function MockButton({tx, onPress}: {tx?: string; onPress?: () => void}) {
    return (
      <TouchableOpacity onPress={onPress}>
        <RNText>{tx}</RNText>
      </TouchableOpacity>
    )
  }
  return {
    Header: MockHeader,
    Screen: MockScreen,
    Button: MockButton,
  }
})

jest.mock("@/components/ignite/Header", () => {
  const {View} = require("react-native")
  function MockHeader() {
    return <View />
  }
  return {
    Header: MockHeader,
  }
})

jest.mock("@/components/ignite/Screen", () => {
  const {View} = require("react-native")
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return {
    Screen: MockScreen,
  }
})

jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => {
  function MockGlassesTroubleshootingModal() {
    return null
  }
  return MockGlassesTroubleshootingModal
})
jest.mock("@/components/glasses/GlassesPairingLoader", () => {
  const {Text} = require("react-native")
  function MockGlassesPairingLoader({isBooting}: {isBooting: boolean}) {
    return <Text>{isBooting ? "booting" : "waiting"}</Text>
  }
  return MockGlassesPairingLoader
})

import {act, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"

import CoreModule from "@mentra/bluetooth-sdk"
import {useRoute} from "@react-navigation/native"
import {useNavigationStore} from "@/stores/navigation"
import {submitAutomaticBugIncident} from "@/services/bugReport/automaticBugReport"
import GlassesPairingLoadingScreen from "@/app/pairing/loading"
import {useGlassesStore} from "@/stores/glasses"
import {emitCoreModuleEvent, resetCoreModuleMock} from "@/test-utils/mockCoreModule"

describe("pairing loading screen", () => {
  const replace = jest.fn()
  const goBack = jest.fn()

  beforeEach(() => {
    jest.useFakeTimers()
    resetCoreModuleMock()
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    ;(useRoute as jest.Mock).mockReturnValue({
      params: {deviceModel: "Mentra Live", deviceName: "MENTRA_LIVE_BLE_001"},
    })
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replace, goBack})
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("shows booting after glasses_not_ready and routes pair failures to the failure screen", async () => {
    const {getByText} = render(<GlassesPairingLoadingScreen />)

    expect(getByText("waiting")).toBeTruthy()

    act(() => {
      emitCoreModuleEvent("glasses_not_ready", {message: "booting"})
    })
    expect(getByText("booting")).toBeTruthy()

    act(() => {
      emitCoreModuleEvent("pair_failure", {error: "pairing:failed"})
    })

    await waitFor(() => {
      expect(CoreModule.forget).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "pairing:failed",
        deviceModel: "Mentra Live",
      })
    })
  })

  it("navigates to success after boot and files a timeout incident after 35 seconds", async () => {
    const first = render(<GlassesPairingLoadingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({fullyBooted: true})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })

    first.unmount()
    resetCoreModuleMock()
    replace.mockClear()
    useGlassesStore.getState().reset()
    render(<GlassesPairingLoadingScreen />)

    act(() => {
      jest.advanceTimersByTime(35_000)
    })

    await waitFor(() => {
      expect(submitAutomaticBugIncident).toHaveBeenCalledWith(
        expect.objectContaining({
          categorization: expect.objectContaining({
            triggerArea: "pairing_loading",
            triggerReason: "glasses_connect_timeout",
          }),
          dedupeKey: "pairing_timeout|Mentra Live|MENTRA_LIVE_BLE_001",
        }),
      )
    })
  })
})
