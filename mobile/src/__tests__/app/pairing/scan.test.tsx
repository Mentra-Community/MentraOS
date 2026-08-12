jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(),
  useFocusEffect: jest.fn(),
}))

jest.mock("@/../../cloud/packages/types/src", () => ({
  DeviceTypes: {
    LIVE: "Mentra Live",
    G1: "Even Realities G1",
    G2: "Even Realities G2",
    AR99: "AR99",
  },
}))

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
  function MockHeader() {
    return <View />
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

import {act, render, fireEvent, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {requestFeaturePermissions} from "@/utils/PermissionsUtils"
import SelectGlassesBluetoothScreen from "@/app/pairing/scan"
import {useCoreStore} from "@mentra/engine/internal"
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine/internal"
import {resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

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
    useCoreStore.getState().reset()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    // The screen reads scan results through the pairing facade now; delegate the
    // mocked facade to the real core store this test seeds via setState().
    ;(engine.pairing.searchResults as jest.Mock).mockImplementation(() => [
      ...useCoreStore.getState().searchResults,
    ])
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

  it("starts a compatible-device search and routes Mentra Live through btclassic on iOS", async () => {
    useCoreStore.setState({
      searchResults: [
        {id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"},
        {id: "b", model: "Even Realities G1", name: "OTHER", address: "b"},
      ],
    })

    render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(engine.pairing.scan).toHaveBeenCalledWith("Mentra Live")
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/btclassic", {
        device: JSON.stringify({id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}),
      })
      expect(pushUnder).toHaveBeenCalledWith("/pairing/loading", {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })

    // Two-phase identity: picking a device must NOT write the default identity —
    // the scan marks the model pending and the native layer promotes on success.
    expect(engine.pairing.setDefault).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().getSetting(SETTINGS.device_name.key)).toBe("")
    expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
  })

  it("marks the chosen model pending on entry", async () => {
    render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
    })
  })

  it("back-out delegates cleanup to the live abandonAttempt and keeps the pending marker", async () => {
    // No entry snapshot: the abandon decision must come from the LIVE
    // default-device read, because a pairing can promote while the flow is
    // open - an entry snapshot would forget that brand-new pairing.
    render(<SelectGlassesBluetoothScreen />)

    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "GO_BACK"})

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith()
    })
    expect(goBack).toHaveBeenCalled()
    expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
  })

  it("forward navigation (replace to btclassic) skips the back-out cleanup", async () => {
    render(<SelectGlassesBluetoothScreen />)

    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "REPLACE"})

    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(goBack).not.toHaveBeenCalled()
  })

  it("routes a pair kickoff rejection to the failure screen instead of leaving loading stuck", async () => {
    jest.useFakeTimers()
    setPlatformOS("android")
    ;(engine.pairing.pair as jest.Mock).mockRejectedValueOnce(new Error("bluetooth powered off"))
    useCoreStore.setState({
      searchResults: [{id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}],
    })

    render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/pairing/loading", {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })

    // The pair kickoff fires 2s after navigating to loading; its rejection
    // must surface as a failure route, not just a console.error.
    act(() => {
      jest.advanceTimersByTime(2_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })
    // Parity with loading.tsx's handlePairFailure: the failed attempt is
    // cleared before the failure screen shows.
    expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
  })

  it("suppresses the kickoff-failure route when the user already left loading", async () => {
    jest.useFakeTimers()
    setPlatformOS("android")
    // The user backed out of /pairing/loading during the 2s kickoff delay —
    // the stale rejection must not yank them to the failure screen.
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({
      replace,
      push,
      goBack,
      history: ["/pairing/scan"],
    })
    ;(engine.pairing.pair as jest.Mock).mockRejectedValueOnce(new Error("bluetooth powered off"))
    useCoreStore.setState({
      searchResults: [{id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}],
    })

    render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(push).toHaveBeenCalled()
    })

    act(() => {
      jest.advanceTimersByTime(2_000)
    })
    await act(async () => {})

    expect(replace).not.toHaveBeenCalledWith("/pairing/failure", expect.anything())
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
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
        deviceModel: "Mentra Live",
        deviceName: "NOTREQUIREDSKIP",
      })
    })
  })
  it("shows retry controls when permission denial blocks Mentra Live auto-connect", async () => {
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
        expect(getByText("pairing:noGlassesFound")).toBeTruthy()
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

      expect(getByText("pairing:noGlassesFound")).toBeTruthy()
    } finally {
      jest.useRealTimers()
    }
  })

  it("Try Again restarts scan in place without navigating back", async () => {
    jest.useFakeTimers()
    try {
      setPlatformOS("android")
      useCoreStore.setState({searchResults: []})
      const {getByText} = render(<SelectGlassesBluetoothScreen />)

      act(() => {
        jest.advanceTimersByTime(15_000)
      })
      expect(getByText("pairing:noGlassesFound")).toBeTruthy()
      ;(engine.pairing.scan as jest.Mock).mockClear()

      fireEvent.press(getByText("pairing:tryAgain"))

      await waitFor(() => {
        expect(engine.pairing.scan).toHaveBeenCalledWith("Mentra Live")
      })
      expect(goBack).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("shows pairing codes for multi-device Mentra Live results", async () => {
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

    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText(/pairing:pairingCodeLabel:A1B2/)).toBeTruthy()
      expect(getByText(/pairing:pairingCodeLabel:C3D4/)).toBeTruthy()
    })
  })

  it("hides Mentra Live units that are not in pairing mode from the scan list", async () => {
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
          id: "pairable",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_PAIR",
          address: "pair",
          pairingMode: true,
          pairingCode: "ABCD",
          securePairingCapable: true,
        },
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(getByText(/pairing:pairingCodeLabel:ABCD/)).toBeTruthy()
    })
    expect(queryByText(/MENTRA_LIVE_BLE_IDLE|IDLE/)).toBeNull()
    expect(queryByText("pairing:notInPairingModeLabel")).toBeNull()
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
