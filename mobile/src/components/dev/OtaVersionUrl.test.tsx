import {engine, SETTINGS} from "@mentra/engine"
import {act, fireEvent, render} from "@testing-library/react-native"

import OtaVersionUrl, {OTA_MANIFEST_PRESETS} from "./OtaVersionUrl"
import {translate} from "@/i18n"

const mockAlert = jest.fn()
const originalFetch = global.fetch
const placeholder = "e.g., http://192.168.1.100:8000/live_version.json"

jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockAlert(...args)}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {textDim: "gray"}}, themed: () => ({})}),
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ui/GlassView", () => ({__esModule: true, default: require("react-native").View}))
jest.mock("@/components/ignite", () => {
  const {Text, Pressable} = require("react-native")
  return {
    Text: ({tx, children, ...props}: {tx?: string; children?: React.ReactNode}) => <Text {...props}>{tx ?? children}</Text>,
    Button: ({text, tx, onPress, disabled}: {text?: string; tx?: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable onPress={onPress} disabled={disabled}>
        <Text>{text ?? tx}</Text>
      </Pressable>
    ),
  }
})

beforeEach(async () => {
  jest.clearAllMocks()
  await engine.settings.setManyLocal({
    [SETTINGS.ota_version_url.key]: null,
    [SETTINGS.saved_ota_version_urls.key]: [],
  })
  jest.spyOn(global, "fetch").mockResolvedValue({ok: true, status: 200, json: async () => ({apps: {}})} as Response)
})

afterAll(() => {
  global.fetch = originalFetch
})

it("lists the April and January factory sets without any bookmarks", () => {
  const screen = render(<OtaVersionUrl />)
  expect(screen.getByText(translate("debug:otaPresetBatch3April"))).toBeTruthy()
  expect(screen.getByText(translate("debug:otaPresetDay1January"))).toBeTruthy()
  expect(screen.queryByText("My URLs")).toBeNull()
})

it.each(OTA_MANIFEST_PRESETS.map((preset) => [translate(preset.labelTx), preset.url]))(
  "fills, tests and saves %s like a bookmark",
  async (label, url) => {
    const screen = render(<OtaVersionUrl />)
    fireEvent.press(screen.getByText(label))
    expect(screen.getByPlaceholderText(placeholder).props.value).toBe(url)

    await act(async () => fireEvent.press(screen.getByText("Save & Test URL")))
    expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({method: "GET"}))
    expect(engine.settings.get(SETTINGS.ota_version_url.key)).toBe(url)
    expect(engine.settings.get(SETTINGS.saved_ota_version_urls.key)).toEqual([])
  },
)

it("does not offer to remove a preset on long press", () => {
  const screen = render(<OtaVersionUrl />)
  fireEvent(screen.getByText(translate("debug:otaPresetBatch3April")), "longPress")
  expect(mockAlert).not.toHaveBeenCalled()
})
