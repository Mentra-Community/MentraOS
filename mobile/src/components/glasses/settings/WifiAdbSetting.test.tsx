import {act, fireEvent, render} from "@testing-library/react-native"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {engine} from "@mentra/engine"

import {WifiAdbSetting} from "./WifiAdbSetting"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/hooks/useEngineSnapshot", () => ({useEngineSnapshot: (read: () => unknown) => read()}))
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {Text: ({text, tx}: {text?: string; tx?: string}) => <Text>{text ?? tx}</Text>}
})
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return {__esModule: true, default: View}
})

const enable = "deviceSettings:wifiAdbEnable"
const disable = "deviceSettings:wifiAdbDisable"
const peer = "2C:BA:CA:25:D8:CC"

beforeEach(() => {
  jest.clearAllMocks()
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Mentra Live", btMac: peer})
  ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "connected"})
  jest.spyOn(engine.settings, "get").mockReturnValue(true)
  ;(BluetoothSdk.setWifiAdbState as jest.Mock).mockResolvedValue(undefined)
})
afterEach(() => jest.restoreAllMocks())

test("only connected identified Mentra Live in Super Mode exposes the commands", () => {
  const screen = render(<WifiAdbSetting superMode={false} />)
  expect(screen.queryByText(enable)).toBeNull()
  screen.rerender(<WifiAdbSetting superMode />)
  expect(screen.getByText(enable)).toBeTruthy()
  for (const info of [{model: "NIMO", btMac: peer}, {model: "Mentra Live"}]) {
    ;(engine.glasses.info as jest.Mock).mockReturnValue(info)
    screen.rerender(<WifiAdbSetting superMode />)
    expect(screen.queryByText(enable)).toBeNull()
  }
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Mentra Live", btMac: peer})
  ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "disconnected"})
  screen.rerender(<WifiAdbSetting superMode />)
  expect(screen.queryByText(enable)).toBeNull()
  expect(BluetoothSdk.setWifiAdbState).not.toHaveBeenCalled()
})

test("explicit commands send true then false and do not claim a verified route", async () => {
  const screen = render(<WifiAdbSetting superMode />)
  await act(async () => fireEvent.press(screen.getByText(enable)))
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenNthCalledWith(1, true)
  expect(screen.getByText("deviceSettings:wifiAdbEnableSent")).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText(disable)))
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenNthCalledWith(2, false)
  expect(screen.getByText("deviceSettings:wifiAdbDisableSent")).toBeTruthy()
})

test("one in-flight command blocks duplicate and opposite input until settlement", async () => {
  let settle!: () => void
  ;(BluetoothSdk.setWifiAdbState as jest.Mock).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve
      }),
  )
  const screen = render(<WifiAdbSetting superMode />)
  act(() => {
    fireEvent.press(screen.getByText(enable))
    fireEvent.press(screen.getByText(enable))
    fireEvent.press(screen.getByText(disable))
  })
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenCalledTimes(1)
  expect(screen.queryByText("deviceSettings:wifiAdbEnableSent")).toBeNull()
  await act(async () => settle())
  expect(screen.getByText("deviceSettings:wifiAdbEnableSent")).toBeTruthy()
})

test("a stale rendered control cannot send after mode or connection changes", () => {
  const screen = render(<WifiAdbSetting superMode />)
  ;(engine.settings.get as jest.Mock).mockReturnValue(false)
  fireEvent.press(screen.getByText(enable))
  ;(engine.settings.get as jest.Mock).mockReturnValue(true)
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Mentra Live", btMac: "11:22:33:44:55:66"})
  fireEvent.press(screen.getByText(enable))
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Mentra Live", btMac: peer})
  ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "disconnected"})
  fireEvent.press(screen.getByText(enable))
  expect(BluetoothSdk.setWifiAdbState).not.toHaveBeenCalled()
})

test("SDK rejection reports failure without automatic retry or exposing native errors", async () => {
  ;(BluetoothSdk.setWifiAdbState as jest.Mock).mockRejectedValue(new Error("private-native-detail"))
  const screen = render(<WifiAdbSetting superMode />)
  await act(async () => fireEvent.press(screen.getByText(enable)))
  expect(screen.getByText("deviceSettings:wifiAdbSendFailed")).toBeTruthy()
  expect(screen.queryByText("deviceSettings:wifiAdbEnableSent")).toBeNull()
  expect(screen.queryByText("private-native-detail")).toBeNull()
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenCalledTimes(1)
})

test("a settled command message is not attributed to a newly selected peer", async () => {
  const screen = render(<WifiAdbSetting superMode />)
  await act(async () => fireEvent.press(screen.getByText(enable)))
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Mentra Live", btMac: "11:22:33:44:55:66"})
  screen.rerender(<WifiAdbSetting superMode />)
  expect(screen.queryByText("deviceSettings:wifiAdbEnableSent")).toBeNull()
})
