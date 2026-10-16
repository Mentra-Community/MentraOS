import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, engine} from "@mentra/engine"
import {act, fireEvent, render} from "@testing-library/react-native"

import {WifiAdbCommands} from "./WifiAdbCommands"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => ({
  Text: ({text}: {text: string}) => require("react").createElement(require("react-native").Text, null, text),
}))
jest.mock("./SettingsCommandButton", () => ({
  SettingsCommandButton: ({label, ...props}: {label: string}) => {
    const React = require("react")
    const {Pressable, Text} = require("react-native")
    return React.createElement(Pressable, {...props, testID: label}, React.createElement(Text, null, label))
  },
}))

const mac = "AA:BB:CC:DD:EE:01"
const enable = "debugSettings:wifiAdbEnable"
const disable = "debugSettings:wifiAdbDisable"

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(engine.glasses.status).mockReturnValue({state: "connected"} as ReturnType<typeof engine.glasses.status>)
  jest
    .mocked(engine.glasses.info)
    .mockReturnValue({model: DeviceTypes.LIVE, btMac: mac} as ReturnType<typeof engine.glasses.info>)
  jest.mocked(BluetoothSdk.setWifiAdbState).mockResolvedValue(undefined)
})

it("sends explicit enable and disable without inferring an initial persisted state", async () => {
  const screen = render(<WifiAdbCommands />)
  await act(async () => fireEvent.press(screen.getByTestId(enable)))
  await act(async () => fireEvent.press(screen.getByTestId(disable)))
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenNthCalledWith(1, true, mac)
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenNthCalledWith(2, false, mac)
  expect(screen.getByText("debugSettings:wifiAdbCommandSent")).toBeTruthy()
})

it.each(["disconnected", "connecting"])("hides commands while %s", (state) => {
  jest.mocked(engine.glasses.status).mockReturnValue({state} as ReturnType<typeof engine.glasses.status>)
  expect(render(<WifiAdbCommands />).queryByTestId(enable)).toBeNull()
  expect(BluetoothSdk.setWifiAdbState).not.toHaveBeenCalled()
})

it("hides commands for another glasses model", () => {
  jest.mocked(engine.glasses.info).mockReturnValue({model: "Mentra Display"} as ReturnType<typeof engine.glasses.info>)
  expect(render(<WifiAdbCommands />).queryByTestId(enable)).toBeNull()
})

it("rechecks the connection before dispatching a stale rendered button", async () => {
  const screen = render(<WifiAdbCommands />)
  jest
    .mocked(engine.glasses.status)
    .mockReturnValue({state: "disconnected"} as ReturnType<typeof engine.glasses.status>)
  await act(async () => fireEvent.press(screen.getByTestId(enable)))
  expect(BluetoothSdk.setWifiAdbState).not.toHaveBeenCalled()
})

it("allows only one pending command and never retries a rejected SDK call", async () => {
  let reject!: (error: Error) => void
  jest.mocked(BluetoothSdk.setWifiAdbState).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail
      }),
  )
  const screen = render(<WifiAdbCommands />)
  await act(async () => {
    fireEvent.press(screen.getByTestId(enable))
    fireEvent.press(screen.getByTestId(disable))
  })
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenCalledTimes(1)
  await act(async () => reject(new Error("delivery lost")))
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenCalledTimes(1)
  expect(screen.getByText("debugSettings:wifiAdbCommandFailed")).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByTestId(disable)))
  expect(BluetoothSdk.setWifiAdbState).toHaveBeenNthCalledWith(2, false, mac)
})

it("requires a full observed MAC and rejects a changed peer before native dispatch", async () => {
  const screen = render(<WifiAdbCommands />)
  jest
    .mocked(engine.glasses.info)
    .mockReturnValue({model: DeviceTypes.LIVE, btMac: "AA:BB:CC:DD:EE:02"} as ReturnType<typeof engine.glasses.info>)
  await act(async () => fireEvent.press(screen.getByTestId(enable)))
  expect(BluetoothSdk.setWifiAdbState).not.toHaveBeenCalled()
  screen.unmount()
  jest
    .mocked(engine.glasses.info)
    .mockReturnValue({model: DeviceTypes.LIVE, btMac: "EE:01"} as ReturnType<typeof engine.glasses.info>)
  expect(render(<WifiAdbCommands />).queryByTestId(enable)).toBeNull()
})
