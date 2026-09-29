import {DeviceEventEmitter, NativeModules, Platform} from "react-native"
// Internal engine adapter; the public engine entry point intentionally excludes it.
// eslint-disable-next-line no-restricted-imports
import {createCloudUdpSocket} from "../modules/engine/src/utils/cloudClient/RnUdpAdapter"

jest.mock("react-native", () => ({
  Platform: {OS: "ios"},
  DeviceEventEmitter: {addListener: jest.fn(() => ({remove: jest.fn()}))},
  NativeModules: {
    UdpSockets: {
      createSocket: jest.fn(),
      bind: jest.fn(),
      connect: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
    },
  },
}))

const native = NativeModules.UdpSockets
const bytes = new Uint8Array([0, 255, 128, 42])

beforeEach(() => {
  jest.clearAllMocks()
  native.connect.mockReset()
  Platform.OS = "ios"
  native.bind.mockImplementation(
    (
      _id: number,
      _port: number,
      _host: string,
      _options: unknown,
      cb: (error: null, address: {address: string; port: number}) => void,
    ) => {
      cb(null, {address: "0.0.0.0", port: 43210})
    },
  )
  native.close.mockImplementation((_id: number, cb: () => void) => cb())
  jest.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => jest.restoreAllMocks())

test("iOS connects once and passes exact encrypted bytes without a per-packet destination", () => {
  const socket = createCloudUdpSocket()
  for (let i = 0; i < 100; i++) socket.send(bytes, "audio.example.test", 8000)
  expect(native.connect).toHaveBeenCalledTimes(1)
  expect(native.connect).toHaveBeenCalledWith(expect.any(Number), 8000, "audio.example.test", expect.any(Function))
  expect(native.send).toHaveBeenCalledTimes(100)
  for (const [, data, port, host] of native.send.mock.calls) {
    expect(Buffer.from(data, "base64")).toEqual(Buffer.from(bytes))
    expect(port).toBe(0)
    expect(host).toBeNull()
  }
  expect(native.bind.mock.invocationCallOrder[0]).toBeLessThan(native.connect.mock.invocationCallOrder[0])
  expect(native.connect.mock.invocationCallOrder[0]).toBeLessThan(native.send.mock.invocationCallOrder[0])
  socket.close()
})

test("connect and first probe stay ordered even before the bind callback returns", () => {
  native.bind.mockImplementation(() => {})
  const socket = createCloudUdpSocket()
  socket.send(bytes, "audio.example.test", 8000)
  expect(native.connect).toHaveBeenCalledTimes(1)
  expect(native.connect.mock.invocationCallOrder[0]).toBeLessThan(native.send.mock.invocationCallOrder[0])
  socket.close()
})

test("failed iOS connect is retried on socket replacement, not on every send", () => {
  jest.spyOn(console, "warn").mockImplementation(() => {})
  native.connect.mockImplementation((_id: number, _port: number, _host: string, cb: (error: string) => void) => {
    cb("DNS lookup failed")
  })
  const first = createCloudUdpSocket()
  first.send(bytes, "audio.example.test", 8000)
  first.send(bytes, "audio.example.test", 8000)
  expect(native.connect).toHaveBeenCalledTimes(1)
  first.close()
  const replacement = createCloudUdpSocket()
  replacement.send(bytes, "audio.example.test", 8000)
  expect(native.connect).toHaveBeenCalledTimes(2)
  replacement.close()
})

test("Android preserves the unconnected native send API", () => {
  Platform.OS = "android"
  const socket = createCloudUdpSocket()
  socket.send(bytes, "audio.example.test", 8000)
  expect(native.connect).not.toHaveBeenCalled()
  expect(native.send).toHaveBeenCalledWith(
    expect.any(Number),
    expect.any(String),
    8000,
    "audio.example.test",
    expect.any(Function),
  )
  socket.close()
})

test("replacement resolves its new peer, while a closed adapter ignores sends and replies", () => {
  const first = createCloudUdpSocket()
  const onBytes = jest.fn()
  first.onMessage(onBytes)
  first.send(bytes, "first.example.test", 8000)
  const receive = (DeviceEventEmitter.addListener as jest.Mock).mock.calls[0][1]
  receive({data: Buffer.from(bytes).toString("base64"), address: "127.0.0.1", port: 8000, ts: "0"})
  expect(onBytes).toHaveBeenCalledWith(bytes)
  first.close()
  first.close()
  first.send(bytes, "first.example.test", 8000)
  receive({data: Buffer.from(bytes).toString("base64"), address: "127.0.0.1", port: 8000, ts: "0"})
  expect(native.close).toHaveBeenCalledTimes(1)
  expect(native.send).toHaveBeenCalledTimes(1)
  expect(onBytes).toHaveBeenCalledTimes(1)
  const second = createCloudUdpSocket()
  second.send(bytes, "second.example.test", 9000)
  expect(native.connect.mock.calls.map((call: unknown[]) => call.slice(1, 3))).toEqual([
    [8000, "first.example.test"],
    [9000, "second.example.test"],
  ])
  second.close()
})
