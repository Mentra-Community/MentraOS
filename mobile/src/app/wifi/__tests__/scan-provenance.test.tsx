import {act, fireEvent, render} from "@testing-library/react-native"
import {engine, type WifiSearchResult} from "@mentra/engine"

import WifiScanScreen from "../scan"

jest.mock("expo-router", () => ({
  useFocusEffect: jest.fn(),
  useLocalSearchParams: () => ({}),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {
    getState: () => ({
      push: jest.fn(),
      goBack: jest.fn(),
      getPreviousRoute: jest.fn(),
      incPreventBack: jest.fn(),
      decPreventBack: jest.fn(),
      setAndroidBackFn: jest.fn(),
      clearHistoryAndGoHome: jest.fn(),
    }),
  },
}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({usePushPrevious: () => jest.fn()}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {text: "#000", textDim: "#888", foreground: "#000"}}}),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text: RNText, View} = require("react-native")
  return {
    Screen: ({children}: {children: unknown}) => <View>{children as never}</View>,
    // The header's right button is the screen's normal "scan again" action.
    Header: ({onRightPress}: {onRightPress?: () => void}) =>
      onRightPress ? <Pressable accessibilityLabel="rescan" onPress={onRightPress} /> : null,
    Button: () => null,
    Text: ({text, children}: {text?: string; children?: unknown}) => <RNText>{text ?? (children as never)}</RNText>,
  }
})
jest.mock("@/components/ui", () => {
  const {View} = require("react-native")
  return {Group: ({children}: {children: unknown}) => <View>{children as never}</View>}
})
jest.mock("@/components/ui/Badge", () => ({Badge: () => null}))
jest.mock("@/components/icons/WifiIcon", () => ({WifiIcon: () => null}))
jest.mock("@/components/icons/WifiLockedIcon", () => ({WifiLockedIcon: () => null}))
jest.mock("@/components/icons/WifiUnlockedIcon", () => ({WifiUnlockedIcon: () => null}))
jest.mock("@/utils/AlertUtils", () => jest.fn())
jest.mock("@/utils/wifi/WifiCredentialsService", () => ({getAllCredentials: () => []}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))

type ChunkCallback = (networks: WifiSearchResult[], meta: {eventId?: string}) => void

describe("Wi-Fi scan render provenance", () => {
  const report = engine.glasses.reportDiagnosticRender as jest.Mock
  let emitChunk: ChunkCallback
  let finishScan: (networks: WifiSearchResult[]) => void

  beforeEach(() => {
    report.mockClear()
    ;(engine.glasses.wifi.onScanResult as jest.Mock).mockImplementation((cb: ChunkCallback) => {
      emitChunk = cb
      return () => {}
    })
    ;(engine.glasses.wifi.scan as jest.Mock).mockImplementation(
      () => new Promise<WifiSearchResult[]>((resolve) => (finishScan = resolve)),
    )
  })

  const network = (ssid: string): WifiSearchResult => ({ssid, requiresPassword: true, signalStrength: -40})

  it("reports every native chunk behind the committed list, including foreign ones", async () => {
    const screen = render(<WifiScanScreen />)
    act(() => emitChunk([network("LabAP")], {eventId: "stream:9"}))
    expect(screen.getByText("LabAP")).toBeTruthy()
    expect(report).toHaveBeenLastCalledWith("wifi_scan", ["stream:9"], 1)

    // A chunk from an older joined scan is merged into the visible list by the normal UI, so the
    // marker must name it too; the consumer rejects any id outside the fresh scan.
    act(() => emitChunk([network("Stale")], {eventId: "stream:4"}))
    expect(report).toHaveBeenLastCalledWith("wifi_scan", ["stream:9", "stream:4"], 2)

    await act(async () => finishScan([network("LabAP"), network("Stale")]))
    expect(report).toHaveBeenLastCalledWith("wifi_scan", ["stream:9", "stream:4"], 2)
    expect(screen.queryByText(/stream:/)).toBeNull()
  })

  it("reports lists without native provenance as empty markers", async () => {
    const screen = render(<WifiScanScreen />)
    act(() => emitChunk([network("LegacyAP")], {}))
    await act(async () => finishScan([network("LegacyAP")]))
    expect(screen.getByText("LegacyAP")).toBeTruthy()
    expect(report).toHaveBeenLastCalledWith("wifi_scan", [], 1)
    expect(report.mock.calls.every(([, ids]) => ids.length === 0)).toBe(true)
  })

  it("invalidates the marker when a chunk without provenance joins the list", () => {
    render(<WifiScanScreen />)
    act(() => emitChunk([network("LabAP")], {eventId: "stream:9"}))
    expect(report).toHaveBeenLastCalledWith("wifi_scan", ["stream:9"], 1)
    act(() => emitChunk([network("LegacyAP")], {}))
    expect(report).toHaveBeenLastCalledWith("wifi_scan", [], 2)
  })

  it("invalidates the previous list when a rescan clears it", () => {
    const screen = render(<WifiScanScreen />)
    act(() => emitChunk([network("LabAP")], {eventId: "stream:9"}))
    expect(report).toHaveBeenLastCalledWith("wifi_scan", ["stream:9"], 1)
    fireEvent.press(screen.getByLabelText("rescan"))
    expect(screen.queryByText("LabAP")).toBeNull()
    expect(report).toHaveBeenLastCalledWith("wifi_scan", [], 0)
  })

  it("invalidates the marker when the scan screen is left", () => {
    const screen = render(<WifiScanScreen />)
    act(() => emitChunk([network("LabAP")], {eventId: "stream:9"}))
    screen.unmount()
    expect(report).toHaveBeenLastCalledWith("wifi_scan", [])
  })
})
