import CoreModule from "@mentra/bluetooth-sdk"

import MockDisplayProcessor from "@/services/DisplayProcessor"
import {useDisplayStore} from "@/stores/display"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@/services/WebSocketManager", () => ({
  __esModule: true,
  default: {
    removeAllListeners: jest.fn(),
    on: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    isConnected: jest.fn(() => true),
    sendText: jest.fn(),
    sendBinary: jest.fn(),
    cleanup: jest.fn(),
  },
}))

jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    getApplets: jest.fn(),
    configureAudioFormat: jest.fn(async () => ({
      is_ok: () => true,
      is_error: () => false,
    })),
  },
}))

jest.mock("@/services/DisplayProcessor", () => ({
  __esModule: true,
  default: {
    processDisplayEvent: jest.fn((msg) => ({
      ...msg,
      _processed: true,
      _profile: "test",
    })),
  },
}))

jest.mock("@/services/AudioPlaybackService", () => ({__esModule: true, default: {}}))
jest.mock("@/services/MantleManager", () => ({__esModule: true, default: {}}))
jest.mock("@/services/UdpManager", () => ({__esModule: true, default: {cleanup: jest.fn()}}))
jest.mock("@/stores/applets", () => ({
  useAppletStatusStore: {
    getState: () => ({
      refreshApplets: jest.fn(),
    }),
  },
}))
jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {MICROPHONE: "microphone"},
  checkFeaturePermissions: jest.fn(() => Promise.resolve(true)),
}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))

const socketComms = jest.requireActual("./SocketComms").default

describe("SocketComms display events", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useDisplayStore.setState({
      currentEvent: {},
      dashboardEvent: {},
      mainEvent: {},
      view: "main",
    })
  })

  it("processes cloud display events before sending them to native and the mirror store", () => {
    socketComms.handle_display_event({
      type: "display_event",
      view: "main",
      layout: {
        layoutType: "text_wall",
        text: "Hello display",
      },
    })

    expect(MockDisplayProcessor.processDisplayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "display_event",
        view: "main",
      }),
    )
    expect(CoreModule.displayEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        _processed: true,
        view: "main",
      }),
    )
    expect(useDisplayStore.getState().mainEvent).toEqual(
      expect.objectContaining({
        _processed: true,
        layout: expect.objectContaining({text: "Hello display"}),
      }),
    )
  })

  it("falls back to the raw event when display processing fails", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    ;(MockDisplayProcessor.processDisplayEvent as jest.Mock).mockImplementationOnce(() => {
      throw new Error("wrap failed")
    })

    const rawEvent = {
      type: "display_event",
      view: "dashboard",
      layout: {
        layoutType: "text_line",
        text: "Raw",
      },
    }

    socketComms.handle_display_event(rawEvent)

    expect(CoreModule.displayEvent).toHaveBeenCalledWith(rawEvent)
    expect(useDisplayStore.getState().dashboardEvent).toEqual(rawEvent)
    expect(consoleErrorSpy).toHaveBeenCalledWith("SOCKET: DisplayProcessor error, using raw event:", expect.any(Error))
    consoleErrorSpy.mockRestore()
  })
})
