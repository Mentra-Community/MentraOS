import {act, fireEvent, render} from "@testing-library/react-native"
import {UnwornPowerOffSetting} from "./UnwornPowerOffSetting"

let mockEnabled = true
let mockListener: (event: unknown) => void
const mockSetEnabled = jest.fn()
const mockQuery = jest.fn(async () => {})
jest.mock("@mentra/engine", () => ({
  SETTINGS: {auto_power_off_enabled: {key: "auto_power_off_enabled"}},
  useSetting: () => [mockEnabled, mockSetEnabled],
}))
jest.mock("@mentra/bluetooth-sdk-internal", () => ({
  __esModule: true,
  default: {
    addListener: (_name: string, callback: (event: unknown) => void) => {
      mockListener = callback
      return {remove: jest.fn()}
    },
    queryWearState: () => mockQuery(),
  },
}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {textDim: "grey"}}})}))
jest.mock("@/i18n/translate", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => ({
  Text: (props: {text: string; testID?: string}) => {
    const {Text} = require("react-native")
    return <Text testID={props.testID}>{props.text}</Text>
  },
}))
jest.mock("@/components/settings/ToggleSetting", () => ({
  __esModule: true,
  default: (props: {testID: string; disabled: boolean; onValueChange: (value: boolean) => void}) => {
    const {Pressable} = require("react-native")
    return <Pressable testID={props.testID} disabled={props.disabled} onPress={() => props.onValueChange(false)} />
  },
}))

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockEnabled = true
  mockSetEnabled.mockResolvedValue({is_error: () => false})
})
afterEach(() => jest.useRealTimers())

it("does not change a user preference when the controls mount", () => {
  const tree = render(<UnwornPowerOffSetting />)
  expect(mockSetEnabled).not.toHaveBeenCalled()
  expect(mockQuery).toHaveBeenCalledTimes(1)
  tree.unmount()
})

it("does not certify a save from an uncorrelated OFF device observation", async () => {
  const tree = render(<UnwornPowerOffSetting />)
  await act(async () => {mockListener({worn: false, enabled: false, elapsedMs: 0, timeoutMs: 1200000})})
  await act(async () => {fireEvent.press(tree.getByTestId("glasses.autoPowerOff.on"))})
  expect(mockSetEnabled).toHaveBeenCalledWith(false)
  expect(tree.queryByTestId("glasses.autoPowerOff.confirmedOff")).toBeNull()
  await act(async () => {mockListener({worn: false, enabled: false, elapsedMs: 0, timeoutMs: 1200000})})
  expect(tree.queryByTestId("glasses.autoPowerOff.confirmedOff")).toBeNull()
  expect(tree.getByTestId("glasses.autoPowerOff.status")).toBeTruthy()
  expect(tree.getByText("deviceSettings:autoPowerOffStatusHint")).toBeTruthy()
  tree.unmount()
})

it("does not certify OFF if saving the preference fails", async () => {
  mockSetEnabled.mockResolvedValue({is_error: () => true, error: new Error("Storage failed")})
  const tree = render(<UnwornPowerOffSetting />)
  await act(async () => {fireEvent.press(tree.getByTestId("glasses.autoPowerOff.on"))})
  await act(async () => {mockListener({worn: false, enabled: false, elapsedMs: 0, timeoutMs: 1200000})})
  expect(tree.queryByTestId("glasses.autoPowerOff.confirmedOff")).toBeNull()
  expect(tree.queryByText("Storage failed")).toBeNull()
  expect(tree.getByText("deviceSettings:autoPowerOffSaveError")).toBeTruthy()
  tree.unmount()
})


it("never labels an old OFF observation confirmed while the saved app preference is ON", async () => {
  const tree = render(<UnwornPowerOffSetting />)
  await act(async () => {mockListener({worn: false, enabled: false})})
  expect(tree.getByTestId("glasses.autoPowerOff.on")).toBeTruthy()
  expect(tree.queryByTestId("glasses.autoPowerOff.confirmedOff")).toBeNull()
  tree.unmount()
})

it("does not expose a raw native query error in the user-facing status", async () => {
  mockQuery.mockRejectedValueOnce(new Error("private native command error"))
  const tree = render(<UnwornPowerOffSetting />)
  mockQuery.mockRejectedValueOnce(new Error("private native command error"))
  await act(async () => {fireEvent.press(tree.getByTestId("glasses.autoPowerOff.on"))})
  expect(tree.queryByText("private native command error")).toBeNull()
  expect(tree.getByText("deviceSettings:autoPowerOffSaveError")).toBeTruthy()
  tree.unmount()
})
