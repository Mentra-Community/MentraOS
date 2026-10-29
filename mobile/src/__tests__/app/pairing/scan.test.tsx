import {act, render, fireEvent, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {engine, SETTINGS} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {useNimoCompanionDiscovery} from "@/hooks/pairing/useNimoCompanionDiscovery"
import SelectGlassesBluetoothScreen from "@/app/pairing/scan"
import {useCoreStore, useSettingsStore} from "@mentra/engine-host-internal"
// The glasses store is private to the local engine workspace and has no public test export.
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("@/hooks/pairing/useNimoCompanionDiscovery", () => ({useNimoCompanionDiscovery: jest.fn()}))

const mockScanFocus: {rerun?: () => void} = {}

jest.mock("expo-router", () => {
  const React = require("react")
  return {
    useLocalSearchParams: jest.fn(),
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockScanFocus.rerun = () => {
        effect()
      }
      React.useEffect(() => effect(), [effect])
    },
  }
})

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushUnder: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {
    LOCATION: "location",
    MICROPHONE: "microphone",
  },
  requestFeaturePermissions: jest.fn(),
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string, vars?: Record<string, string>) => {
    if (vars?.model) {
      return `${key}:${vars.model}`
    }
    if (vars?.code) {
      return `${key}:${vars.code}`
    }
    return key
  }),
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {
        foreground: "#000",
        text: "#111",
      },
    },
  }),
}))

jest.mock("@/components/brands/MentraLogoStandalone", () => ({
  MentraLogoStandalone: function MockMentraLogoStandalone() {
    return null
  },
}))

jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => {
  function MockGlassesTroubleshootingModal() {
    return null
  }
  return MockGlassesTroubleshootingModal
})
jest.mock("@/components/ui/Divider", () => {
  function MockDivider() {
    return null
  }
  return MockDivider
})
jest.mock("@/components/ui/Group", () => ({
  Group: function MockGroup({children}: {children: ReactNode}) {
    return children
  },
}))
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return MockGlassView
})
jest.mock("@/utils/getGlassesImage", () => ({
  AR99_MODEL_OPTIONS: [{projectName: "AR99", displayName: "Xingyi AR99"}],
  getAr99DisplayName: jest.fn((projectName?: string) => {
    return projectName === "AR99" ? "Xingyi AR99" : "AR99"
  }),
  getAr99ImageSource: jest.fn(() => 1),
  getGlassesOpenImage: jest.fn(() => 1),
}))
jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  function MockIcon() {
    return <View />
  }
  function MockHeader({onLeftPress}: {onLeftPress: () => void}) {
    return <TouchableOpacity accessibilityLabel="common:back" onPress={onLeftPress} />
  }
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  function MockText({text}: {text?: string}) {
    return <RNText>{text}</RNText>
  }
  function MockButton({tx, text, onPress}: {tx?: string; text?: string; onPress?: () => void}) {
    return (
      <TouchableOpacity onPress={onPress}>
        <RNText>{text || tx}</RNText>
      </TouchableOpacity>
    )
  }
  return {
    Icon: MockIcon,
    Header: MockHeader,
    Screen: MockScreen,
    Text: MockText,
    Button: MockButton,
  }
})

const originalPlatformOS = Platform.OS

function setPlatformOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, "OS", {value: os, configurable: true, writable: true})
}

describe("pairing scan screen", () => {
  const replace = jest.fn()
  const push = jest.fn()
  const pushUnder = jest.fn()
  const goBack = jest.fn()

  beforeEach(() => {
    resetBluetoothSdkMock()
    jest.clearAllMocks()
    ;(engine.pairing.diagnoseEmptyScan as jest.Mock).mockReset().mockResolvedValue(null)
    ;(engine.pairing.pair as jest.Mock).mockReset().mockResolvedValue(undefined)
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    // The screen reads scan results through the pairing facade now; delegate the
    // mocked facade to the real core store this test seeds via setState().
    ;(engine.pairing.searchResults as jest.Mock).mockImplementation(() => [...useCoreStore.getState().searchResults])
    ;(engine.pairing.onFound as jest.Mock).mockImplementation((cb: (results: unknown) => void) =>
      useCoreStore.subscribe((s) => s.searchResults, cb),
    )
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValue(true)
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "Mentra Live"})
    // history models the stack after push("/pairing/loading") — only the
    // kickoff-failure guard reads it.
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({
      replace,
      push,
      goBack,
      history: ["/pairing/scan", "/pairing/loading"],
    })
    ;(usePushUnder as jest.Mock).mockReturnValue(pushUnder)
    ;(requestFeaturePermissions as jest.Mock).mockResolvedValue(true)
    setPlatformOS("ios")
  })

  afterEach(() => {
    jest.useRealTimers()
    setPlatformOS(originalPlatformOS)
  })

  it.each(["", "Even Realities G1"])(
    "persists iOS NIMO before discovery, replacing pending model %s",
    async (pending) => {
      await useSettingsStore.getState().setSetting(SETTINGS.pending_wearable.key, pending, false)
      ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "NIMO"})
      ;(useNimoCompanionDiscovery as jest.Mock).mockReturnValue({
        devices: [],
        requiresSelection: false,
        needsRetry: false,
        retry: jest.fn(),
        select: jest.fn(),
      })
      const screen = render(<SelectGlassesBluetoothScreen />)
      await waitFor(() => {
        expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("NIMO")
      })
      expect(useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)).toBe("")
      expect(replace).not.toHaveBeenCalled()
      screen.unmount()
      expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("NIMO")
    },
  )

  it("keeps the remaining NIMO selectable after the chooser has been shown", () => {
    const device = {id: "nimo-a", name: "Nimo-4027", model: "NIMO", address: "nimo-a"}
    const select = jest.fn()
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "NIMO"})
    ;(useNimoCompanionDiscovery as jest.Mock).mockReturnValue({
      devices: [device],
      requiresSelection: true,
      needsRetry: false,
      retry: jest.fn(),
      select,
    })
    const screen = render(<SelectGlassesBluetoothScreen />)
    expect(screen.getByRole("button", {name: "NIMO, Nimo-4027"})).toBeTruthy()
    expect(screen.queryByText("onboarding:openSettings")).toBeNull()
    fireEvent.press(screen.getByTestId("pairing-device-chevron"))
    expect(select).toHaveBeenCalledWith(device)
  })

  it.each([false, true])("pairs when tapping the chevron, including after timeout (%s)", async (timedOut) => {
    jest.useFakeTimers()
    useCoreStore.setState({
      searchResults: [
        {
          id: "a",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_E7FA",
          address: "a",
          pairingMode: true,
          pairingCode: "A1B2",
          securePairingCapable: true,
        },
      ],
    })
    const screen = render(<SelectGlassesBluetoothScreen />)
    if (timedOut) await act(async () => jest.advanceTimersByTime(15_000))
    // The chevron itself, not the label, must bubble the press to the whole card.
    fireEvent.press(screen.getByTestId("pairing-device-chevron"))
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({deviceName: "MENTRA_LIVE_BLE_E7FA"}),
      )
    })
  })

  it("routes Mentra Live straight to BLE loading on iOS even without phone microphone permission", async () => {
    ;(requestFeaturePermissions as jest.Mock).mockResolvedValue(false)
    useCoreStore.setState({
      searchResults: [
        {id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"},
        {id: "b", model: "Even Realities G1", name: "OTHER", address: "b"},
      ],
    })

    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(engine.pairing.scan).toHaveBeenCalledWith("Mentra Live")
      expect(getByText("001")).toBeTruthy()
    })

    fireEvent.press(getByText("001"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/pairing/loading", {
        device: JSON.stringify({id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}),
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })
    expect(replace).not.toHaveBeenCalled()

    expect(requestFeaturePermissions).not.toHaveBeenCalled()

    fireEvent.press(getByText("001"))
    expect(push).toHaveBeenCalledTimes(1)

    act(() => {
      mockScanFocus.rerun?.()
    })
    fireEvent.press(getByText("001"))
    expect(push).toHaveBeenCalledTimes(2)

    // Two-phase identity: picking a device must NOT write the default identity —
    // the scan marks the model pending and the native layer promotes on success.
    expect(engine.pairing.setDefault).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().getSetting(SETTINGS.device_name.key)).toBe("")
    expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
  })

  it("marks the chosen model pending on entry", async () => {
    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
    })
    expect(getByText("pairing:livePairingScanTitle")).toBeTruthy()
  })

  it("shows the secure pairing-mode instructions with a small searching spinner (S2)", async () => {
    const screen = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(engine.pairing.scan).toHaveBeenCalledWith("Mentra Live")
    })
    expect(screen.getByText("pairing:livePairingScanTitle")).toBeTruthy()
    expect(screen.getByText("pairing:livePairingScanPowerOn")).toBeTruthy()
    expect(screen.getByText("pairing:livePairingScanBody")).toBeTruthy()
    expect(screen.getByText("pairing:livePairingScanSearching")).toBeTruthy()
    expect(screen.getByTestId("live-scan-searching-spinner").props.size).toBe("small")
    expect(screen.getByText("pairing:needMoreHelp")).toBeTruthy()
    expect(screen.getByLabelText("common:back")).toBeTruthy()
    // The tutorial step is gone from the scan.
    expect(screen.queryByText("pairing:livePairingModeTitle")).toBeNull()
  })

  it("uses the exact English copy for the secure scan screen (S2)", () => {
    expect(en.pairing.livePairingScanTitle).toBe("Put your glasses in pairing mode")
    expect(en.pairing.livePairingScanPowerOn).toBe("Turn your glasses on: hold the power button for 5 seconds.")
    expect(en.pairing.liveChooseGlassesHintTitle).toBe("Not on the list?")
    expect(en.pairing.liveChooseGlassesHint).toBe(
      "Turn your glasses on, then press the power button 3 times quickly to enter pairing mode.",
    )
    expect(en.pairing.livePairingScanBody).toBe(
      "Press the power button 3 times quickly. Your glasses will say a 4-character code.",
    )
    expect(en.pairing.livePairingScanSearching).toBe("Looking for your glasses")
    expect(en.pairing.needMoreHelp).toBe("I need more help")
    expect(en.pairing.liveChooseGlassesTitle).toBe("Choose your glasses")
  })

  it("never auto-connects a single discovered Mentra Live, even one in pairing mode (S3)", async () => {
    jest.useFakeTimers()
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "only",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_ONLY",
          address: "only",
          pairingMode: true,
          pairingCode: "WXYZ",
          securePairingCapable: true,
        },
      ],
    })

    const screen = render(<SelectGlassesBluetoothScreen />)
    await act(async () => jest.advanceTimersByTime(60_000))

    expect(screen.getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(engine.pairing.pair).not.toHaveBeenCalled()

    fireEvent.press(screen.getByText("ONLY"))
    await waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1)
    })
  })

  it("back-out delegates cleanup to the live abandonAttempt and retires the pending selection", async () => {
    // No entry snapshot: the abandon decision must come from the LIVE
    // default-device read, because a pairing can promote while the flow is
    // open - an entry snapshot would forget that brand-new pairing.
    const screen = render(<SelectGlassesBluetoothScreen />)
    expect(screen.queryByText("common:cancel")).toBeNull()
    fireEvent.press(screen.getByLabelText("common:back"))

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    })
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("falls back to the plain back-out cleanup when the selection cannot be cancelled", async () => {
    ;(engine.pairing.abandonAttempt as jest.Mock)
      .mockRejectedValueOnce(new Error("native read failed"))
      .mockResolvedValueOnce(undefined)
    const screen = render(<SelectGlassesBluetoothScreen />)
    fireEvent.press(screen.getByLabelText("common:back"))

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(2)
    })
    expect(engine.pairing.abandonAttempt).toHaveBeenNthCalledWith(1, {clearPendingSelection: true})
    expect(engine.pairing.abandonAttempt).toHaveBeenNthCalledWith(2)
  })

  it("an iOS back swipe cleans up once without popping model selection too", async () => {
    render(<SelectGlassesBluetoothScreen />)

    // The beforeRemove listener: the swipe is already removing the screen.
    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "POP"})
    backHandler({actionType: "POP"})

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    })
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(goBack).not.toHaveBeenCalled()
  })

  it("the back chevron pops once even though its goBack() reaches beforeRemove", async () => {
    const screen = render(<SelectGlassesBluetoothScreen />)
    fireEvent.press(screen.getByLabelText("common:back"))
    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "GO_BACK"})

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    })
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("Android back runs the cleanup and pops the scan screen", async () => {
    setPlatformOS("android")
    render(<SelectGlassesBluetoothScreen />)

    // The registered Android back handler is called without an event.
    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler()

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    })
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("forward navigation (replace to btclassic) skips the back-out cleanup", async () => {
    render(<SelectGlassesBluetoothScreen />)

    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "REPLACE"})

    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(goBack).not.toHaveBeenCalled()
  })

  it("hands the selected device to loading on Android without microphone permission", async () => {
    ;(requestFeaturePermissions as jest.Mock).mockImplementation(
      async (feature) => feature !== PermissionFeatures.MICROPHONE,
    )
    jest.useFakeTimers()
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [{id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}],
    })

    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("001")).toBeTruthy()
    })
    fireEvent.press(getByText("001"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/pairing/loading", {
        device: JSON.stringify({id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}),
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })

    // Loading owns the delayed kickoff so leaving that route can cancel it.
    act(() => {
      jest.advanceTimersByTime(3_000)
    })
    expect(engine.pairing.pair).not.toHaveBeenCalled()
    expect(requestFeaturePermissions).not.toHaveBeenCalledWith(PermissionFeatures.MICROPHONE)
  })

  it("auto-skips directly into pairing when NOTREQUIREDSKIP is discovered", async () => {
    setPlatformOS("android")
    useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: false})
    useCoreStore.setState({
      searchResults: [{id: "skip", model: "Mentra Live", name: "NOTREQUIREDSKIP", address: "skip"}],
    })

    render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/pairing/loading", {
        device: JSON.stringify({id: "skip", model: "Mentra Live", name: "NOTREQUIREDSKIP", address: "skip"}),
        deviceModel: "Mentra Live",
        deviceName: "NOTREQUIREDSKIP",
      })
    })
  })
  it("shows retry controls when permission denial blocks a selected Mentra Live", async () => {
    jest.useFakeTimers()
    try {
      setPlatformOS("android")
      ;(requestFeaturePermissions as jest.Mock).mockResolvedValue(false)
      useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: false})
      useCoreStore.setState({
        searchResults: [{id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}],
      })

      const {getByText} = render(<SelectGlassesBluetoothScreen />)

      await waitFor(() => {
        expect(getByText("001")).toBeTruthy()
      })
      fireEvent.press(getByText("001"))

      await waitFor(() => {
        expect(getByText("pairing:tryAgain")).toBeTruthy()
      })
      const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
      expect(bluetoothSdkMock.stopScan).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("times out only when Mentra Live scan finds zero eligible glasses", async () => {
    jest.useFakeTimers()
    try {
      setPlatformOS("android")
      useCoreStore.setState({searchResults: []})

      const {getByText} = render(<SelectGlassesBluetoothScreen />)

      act(() => {
        jest.advanceTimersByTime(15_000)
      })

      expect(getByText("pairing:liveScanHelpTitle")).toBeTruthy()
      expect(getByText("pairing:liveScanHelpInfo")).toBeTruthy()
      expect(getByText("pairing:liveUpdatedGlassesHint")).toBeTruthy()
      expect(getByText("pairing:livePairingModeInfo")).toBeTruthy()
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows a connected-device advisory after an empty scan and clears it on retry", async () => {
    jest.useFakeTimers()
    setPlatformOS("android")
    ;(engine.pairing.diagnoseEmptyScan as jest.Mock).mockResolvedValue({
      code: "device_connected_on_phone",
      message: "Matching glasses are connected",
    })
    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    expect(getByText("pairing:connectedOnPhoneTitle")).toBeTruthy()
    expect(getByText("pairing:connectedOnPhoneHint")).toBeTruthy()
    await act(async () => {
      fireEvent.press(getByText("pairing:tryAgain"))
    })
    expect(queryByText("pairing:connectedOnPhoneTitle")).toBeNull()
  })

  it("ignores an old advisory lookup after Scan Again starts a new scan", async () => {
    jest.useFakeTimers()
    setPlatformOS("android")
    let resolveDiagnostic!: (value: unknown) => void
    ;(engine.pairing.diagnoseEmptyScan as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveDiagnostic = resolve
      }),
    )
    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)
    await act(async () => {
      jest.advanceTimersByTime(15_000)
    })
    fireEvent.press(getByText("pairing:scanAgain"))
    await act(async () => {
      resolveDiagnostic({code: "device_connected_on_phone", message: "Old scan"})
    })
    expect(queryByText("pairing:connectedOnPhoneTitle")).toBeNull()
  })

  it("Scan Again restarts scan in place without navigating back", async () => {
    jest.useFakeTimers()
    try {
      setPlatformOS("android")
      useCoreStore.setState({searchResults: []})
      const {getByText} = render(<SelectGlassesBluetoothScreen />)

      act(() => {
        jest.advanceTimersByTime(15_000)
      })
      expect(getByText("pairing:liveScanHelpTitle")).toBeTruthy()
      ;(engine.pairing.scan as jest.Mock).mockClear()

      fireEvent.press(getByText("pairing:scanAgain"))

      await waitFor(() => {
        expect(engine.pairing.scan).toHaveBeenCalledWith("Mentra Live")
      })
      expect(goBack).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows device identifiers without a separate pairing-code label", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "a",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_001",
          address: "a",
          pairingCode: "A1B2",
          pairingMode: true,
          securePairingCapable: true,
        },
        {
          id: "b",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_002",
          address: "b",
          pairingCode: "C3D4",
          securePairingCapable: false,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(getByText("001")).toBeTruthy()
      expect(getByText("002")).toBeTruthy()
    })
    expect(queryByText(/pairing:pairingCodeLabel/)).toBeNull()
  })

  it("lists only Mentra Live units that are in pairing mode", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "idle",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_IDLE",
          address: "idle",
          pairingMode: false,
          securePairingCapable: true,
        },
        {
          id: "pairable-a",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_PAIR_A",
          address: "pair-a",
          pairingMode: true,
          pairingCode: "ABCD",
          securePairingCapable: true,
        },
        {
          id: "pairable-b",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_PAIR_B",
          address: "pair-b",
          pairingMode: true,
          pairingCode: "EF01",
          securePairingCapable: true,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(getByText("PAIR_A")).toBeTruthy()
      expect(getByText("PAIR_B")).toBeTruthy()
    })
    expect(queryByText(/IDLE/)).toBeNull()
    expect(queryByText(/pairing:notInPairingModeLabel/)).toBeNull()
    expect(queryByText(/pairing:pairingCodeLabel/)).toBeNull()
  })

  it("shows a single pairing-mode Mentra Live and waits for the user to choose it", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "idle",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_IDLE",
          address: "idle",
          pairingMode: false,
          securePairingCapable: true,
        },
        {
          id: "pairable-a",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_PAIR_A",
          address: "pair-a",
          pairingMode: true,
          pairingCode: "ABCD",
          securePairingCapable: true,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(getByText("PAIR_A")).toBeTruthy()
    })
    // The idle unit is off the list, so the chooser still says how to enter pairing mode.
    expect(getByText("pairing:liveChooseGlassesHintTitle")).toBeTruthy()
    expect(getByText("pairing:liveChooseGlassesHint")).toBeTruthy()
    expect(queryByText(/IDLE/)).toBeNull()
    expect(push).not.toHaveBeenCalled()

    fireEvent.press(getByText("PAIR_A"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({
          deviceModel: "Mentra Live",
          deviceName: "MENTRA_LIVE_BLE_PAIR_A",
          pairingCode: "ABCD",
        }),
      )
    })
  })

  it("shows existing customer firmware without labeling it as legacy", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "existing",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_EXISTING",
          address: "existing",
          pairingMode: false,
          securePairingCapable: false,
        },
      ],
    })

    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(getByText("EXISTING")).toBeTruthy()
    })
    expect(push).not.toHaveBeenCalled()

    fireEvent.press(getByText("EXISTING"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({
          deviceModel: "Mentra Live",
          deviceName: "MENTRA_LIVE_BLE_EXISTING",
          securePairingCapable: false,
        }),
      )
    })
  })

  it("shows existing customer firmware beside an idle secure unit", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "idle",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_IDLE",
          address: "idle",
          pairingMode: false,
          securePairingCapable: true,
        },
        {
          id: "existing",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_EXISTING",
          address: "existing",
          pairingMode: false,
          securePairingCapable: false,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(getByText("EXISTING")).toBeTruthy()
    })
    expect(queryByText(/IDLE/)).toBeNull()
    expect(push).not.toHaveBeenCalled()

    fireEvent.press(getByText("EXISTING"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({
          deviceModel: "Mentra Live",
          deviceName: "MENTRA_LIVE_BLE_EXISTING",
          securePairingCapable: false,
        }),
      )
    })
    expect(push).toHaveBeenCalledTimes(1)
  })

  it("keeps the pairing-mode screen while only idle secure glasses are nearby", async () => {
    setPlatformOS("android")
    useCoreStore.setState({
      searchResults: [
        {
          id: "idle",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_IDLE",
          address: "idle",
          pairingMode: false,
          securePairingCapable: true,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:livePairingScanTitle")).toBeTruthy()
      expect(getByText("pairing:livePairingScanSearching")).toBeTruthy()
    })
    expect(queryByText("pairing:liveChooseGlassesTitle")).toBeNull()
    expect(queryByText(/IDLE/)).toBeNull()
    const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
    expect(bluetoothSdkMock.stopScan).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    act(() => {
      useCoreStore.setState({
        searchResults: [
          {
            id: "idle",
            model: "Mentra Live",
            name: "MENTRA_LIVE_BLE_IDLE",
            address: "idle",
            pairingMode: false,
            securePairingCapable: true,
          },
          {
            id: "target",
            model: "Mentra Live",
            name: "MENTRA_LIVE_BLE_TARGET",
            address: "target",
            pairingMode: true,
            pairingCode: "A1B2",
            securePairingCapable: true,
          },
        ],
      })
    })

    await waitFor(() => {
      expect(getByText("pairing:liveChooseGlassesTitle")).toBeTruthy()
      expect(queryByText(/IDLE/)).toBeNull()
      expect(getByText("TARGET")).toBeTruthy()
    })
    expect(push).not.toHaveBeenCalled()

    fireEvent.press(getByText("TARGET"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({deviceName: "MENTRA_LIVE_BLE_TARGET"}),
      )
    })
  })

  it("lets the user connect once the same glasses enter pairing mode", async () => {
    setPlatformOS("ios")
    useCoreStore.setState({
      searchResults: [
        {
          id: "idle",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_IDLE",
          address: "idle",
          pairingMode: false,
          securePairingCapable: true,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText("pairing:livePairingScanTitle")).toBeTruthy()
      expect(queryByText(/IDLE/)).toBeNull()
    })

    act(() => {
      useCoreStore.setState({
        searchResults: [
          {
            id: "idle",
            model: "Mentra Live",
            name: "MENTRA_LIVE_BLE_IDLE",
            address: "idle",
            pairingMode: true,
            pairingCode: "A1B2",
            securePairingCapable: true,
          },
        ],
      })
    })

    await waitFor(() => {
      expect(queryByText(/pairing:notInPairingModeLabel/)).toBeNull()
      expect(getByText("IDLE")).toBeTruthy()
    })

    fireEvent.press(getByText("IDLE"))

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(
        "/pairing/loading",
        expect.objectContaining({
          deviceName: "MENTRA_LIVE_BLE_IDLE",
          pairingCode: "A1B2",
        }),
      )
    })
  })

  it("filters AR99 scan results to the selected AR99 project", async () => {
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "AR99", ar99ProjectName: "AR99"})
    useCoreStore.setState({
      searchResults: [
        {id: "ar99", model: "AR99", projectName: "AR99", name: "SN: 123456", address: "AA:BB:CC:DD:EE:11"},
        {id: "af99", model: "AR99", projectName: "AF99", name: "SN: 654321", address: "AA:BB:CC:DD:EE:22"},
        {id: "hvxf", model: "AR99", projectName: "HVXF", name: "MAC: 22:33:44:55:66:77", address: "AA:BB:CC:DD:EE:33"},
        {id: "missing", model: "AR99", name: "AR99_123456", address: "AA:BB:CC:DD:EE:44"},
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(engine.pairing.scan).toHaveBeenCalledWith("AR99")
    })

    expect(getByText("Xingyi AR99")).toBeTruthy()
    expect(queryByText("Xingyi AR99 CAT")).toBeNull()
    expect(queryByText("HOLOVOX Luna")).toBeNull()
    expect(queryByText("AR99_123456")).toBeNull()
  })

  it("does not wildcard AR99 results when no project was selected", async () => {
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "AR99"})
    useCoreStore.setState({
      searchResults: [
        {id: "ar99", model: "AR99", projectName: "AR99", name: "SN: 123456", address: "AA:BB:CC:DD:EE:55"},
      ],
    })

    const {queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(engine.pairing.scan).toHaveBeenCalledWith("AR99")
    })

    expect(queryByText("Xingyi AR99")).toBeNull()
  })
})
