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

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    writeUserSettings: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
  },
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string, vars?: Record<string, string>) => {
    if (vars?.model) {
      return `${key}:${vars.model}`
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
  AR99_MODEL_OPTIONS: [
    {projectName: "AR99", displayName: "Xingyi AR99"},
    {projectName: "AF99", displayName: "Xingyi AR99 CAT"},
    {projectName: "HVXM", displayName: "HOLOVOX Legacy"},
    {projectName: "HVXF", displayName: "HOLOVOX Luna"},
  ],
  getAr99DisplayName: jest.fn((projectName?: string) => {
    const match = [
      {projectName: "AR99", displayName: "Xingyi AR99"},
      {projectName: "AF99", displayName: "Xingyi AR99 CAT"},
      {projectName: "HVXM", displayName: "HOLOVOX Legacy"},
      {projectName: "HVXF", displayName: "HOLOVOX Luna"},
    ].find((option) => option.projectName === projectName)
    return match?.displayName ?? "AR99"
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

import {render, fireEvent, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {toolkit} from "@mentra/island"
import {useLocalSearchParams} from "expo-router"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {requestFeaturePermissions} from "@/utils/PermissionsUtils"
import SelectGlassesBluetoothScreen from "@/app/pairing/scan"
import {useCoreStore} from "@/stores/core"
import {useGlassesStore} from "../../../../modules/island/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
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
    ;(toolkit.pairing.searchResults as jest.Mock).mockImplementation(() => [
      ...useCoreStore.getState().searchResults,
    ])
    ;(toolkit.pairing.onFound as jest.Mock).mockImplementation((cb: (results: unknown) => void) =>
      useCoreStore.subscribe((s) => s.searchResults, cb),
    )
    ;(toolkit.glasses.hasDefaultDevice as jest.Mock).mockResolvedValue(true)
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "Mentra Live"})
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replace, push, goBack})
    ;(usePushUnder as jest.Mock).mockReturnValue(pushUnder)
    ;(requestFeaturePermissions as jest.Mock).mockResolvedValue(true)
    setPlatformOS("ios")
  })

  afterEach(() => {
    setPlatformOS(originalPlatformOS)
  })

  it("starts a compatible-device search and routes Mentra Live through btclassic on iOS", async () => {
    useCoreStore.setState({
      searchResults: [
        {id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"},
        {id: "b", model: "Even Realities G1", name: "OTHER", address: "b"},
      ],
    })

    const {getByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(toolkit.pairing.scan).toHaveBeenCalledWith("Mentra Live")
    })

    fireEvent.press(getByText("001"))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/btclassic", {
        device: JSON.stringify({id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}),
      })
      expect(pushUnder).toHaveBeenCalledWith("/pairing/loading", {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })

    // Two-phase identity: picking a device must NOT write the default identity -
    // the scan marks the model pending and the native layer promotes on success.
    expect(toolkit.pairing.setDefault).not.toHaveBeenCalled()
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
      expect(toolkit.pairing.abandonAttempt).toHaveBeenCalledWith()
    })
    expect(goBack).toHaveBeenCalled()
    expect(useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)).toBe("Mentra Live")
  })

  it("forward navigation (replace to btclassic) skips the back-out cleanup", async () => {
    render(<SelectGlassesBluetoothScreen />)

    const backHandler = (focusEffectPreventBack as jest.Mock).mock.calls[0][0]
    backHandler({actionType: "REPLACE"})

    expect(toolkit.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(goBack).not.toHaveBeenCalled()
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
  it("filters AR99-family scan results to the selected project", async () => {
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "AR99", ar99ProjectName: "HVXM"})
    useCoreStore.setState({
      searchResults: [
        {id: "legacy", model: "AR99", projectName: "HVXM", name: "MAC: 11:22:33:44:55:66", address: "AA:BB:CC:DD:EE:11"},
        {id: "luna", model: "AR99", projectName: "HVXF", name: "MAC: 22:33:44:55:66:77", address: "AA:BB:CC:DD:EE:22"},
        {id: "missing", model: "AR99", name: "AR99_123456", address: "AA:BB:CC:DD:EE:33"},
        {id: "unsupported", model: "AR99", projectName: "AF98", name: "AF98_123456", address: "AA:BB:CC:DD:EE:44"},
      ],
    })

    const {getByText, queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(toolkit.pairing.scan).toHaveBeenCalledWith("AR99")
    })

    expect(getByText("HOLOVOX Legacy")).toBeTruthy()
    expect(queryByText("HOLOVOX Luna")).toBeNull()
    expect(queryByText("AR99_123456")).toBeNull()
    expect(queryByText("AF98_123456")).toBeNull()
  })

  it("does not wildcard AR99-family results when no project was selected", async () => {
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({deviceModel: "AR99"})
    useCoreStore.setState({
      searchResults: [
        {id: "ar99", model: "AR99", projectName: "AR99", name: "SN: 123456", address: "AA:BB:CC:DD:EE:55"},
      ],
    })

    const {queryByText} = render(<SelectGlassesBluetoothScreen />)

    await waitFor(() => {
      expect(toolkit.pairing.scan).toHaveBeenCalledWith("AR99")
    })

    expect(queryByText("Xingyi AR99")).toBeNull()
  })
})
