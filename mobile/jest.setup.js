/* eslint-env jest */

// Mock react-native-permissions
jest.mock("react-native-permissions", () => require("react-native-permissions/mock"))

// Mock react-native-mmkv
jest.mock("react-native-mmkv", () => {
  const mockStorage = new Map([
    ["string", '"string"'],
    ["object", '{"x":1}'],
  ])

  return {
    MMKV: jest.fn().mockImplementation(() => ({
      getString: jest.fn(key => mockStorage.get(key)),
      set: jest.fn((key, value) => mockStorage.set(key, value)),
      delete: jest.fn(key => mockStorage.delete(key)),
      clearAll: jest.fn(() => mockStorage.clear()),
      getAllKeys: jest.fn(() => Array.from(mockStorage.keys())),
    })),
  }
})

// Mock react-native-localize
jest.mock("react-native-localize", () => ({
  getLocales: jest.fn(() => [
    {
      countryCode: "US",
      languageTag: "en-US",
      languageCode: "en",
      isRTL: false,
    },
  ]),
  getNumberFormatSettings: jest.fn(() => ({
    decimalSeparator: ".",
    groupingSeparator: ",",
  })),
  getCalendar: jest.fn(() => "gregorian"),
  getCountry: jest.fn(() => "US"),
  getCurrencies: jest.fn(() => ["USD", "EUR"]),
  getTemperatureUnit: jest.fn(() => "celsius"),
  getTimeZone: jest.fn(() => "America/New_York"),
  uses24HourClock: jest.fn(() => false),
  usesMetricSystem: jest.fn(() => false),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}))

// Mock expo-audio
jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({
    src: null,
    play: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    remove: jest.fn(),
  })),
}))

// Mock MantleBridge
jest.mock("@/bridge/MantleBridge", () => {
  const {EventEmitter} = require("events")

  class MockMantleBridge extends EventEmitter {
    static getInstance = jest.fn(() => new MockMantleBridge())
    connect = jest.fn()
    disconnect = jest.fn()
    sendMessage = jest.fn()
    cleanup = jest.fn()
  }

  return {
    default: new MockMantleBridge(),
  }
})

// Mock SocketComms to avoid complex dependency chains
jest.mock("@/services/SocketComms", () => ({
  default: {
    getInstance: jest.fn(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      send_socket_message: jest.fn(),
      cleanup: jest.fn(),
    })),
  },
}))

// Mock WebSocketManager to avoid circular dependency issues
jest.mock("@/services/WebSocketManager", () => {
  const {EventEmitter} = require("events")

  const WebSocketStatus = {
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    ERROR: "error",
  }

  class MockWebSocketManager extends EventEmitter {
    connect = jest.fn()
    disconnect = jest.fn()
    isConnected = jest.fn(() => false)
    sendText = jest.fn()
    sendBinary = jest.fn()
    cleanup = jest.fn()
  }

  return {
    WebSocketStatus,
    default: new MockWebSocketManager(),
  }
})

// Mock core native module to avoid native bridge errors
jest.mock("core", () => ({
  default: {
    getBluetoothStatus: jest.fn(() => Promise.resolve("disabled")),
    requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
    // Add other methods as needed
  },
}))

// Silence the warning: Animated: `useNativeDriver` is not supported
global.__reanimatedWorkletInit = jest.fn()
