import {waitFor} from "@testing-library/react-native"

import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {useConnectionStore} from "@/stores/connection"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {WebSocketStatus} from "@/services/ws-types"

jest.mock("@mentra/bluetooth-sdk-internal", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

const mockRequest = jest.fn()

jest.mock("axios", () => {
  const mockAxios = {
    create: jest.fn(() => ({
      request: (...args: unknown[]) => mockRequest(...args),
    })),
    isAxiosError: jest.fn((error) => !!error?.isAxiosError),
  }

  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios,
  }
})

jest.mock("@/../../cloud/packages/types/src", () => ({}))

const restComms = jest.requireActual("@/services/RestComms").default

let fakeTimersEnabled = false

function useScopedFakeTimers() {
  jest.useFakeTimers()
  fakeTimersEnabled = true
}

describe("RestComms", () => {
  beforeEach(() => {
    fakeTimersEnabled = false
    mockRequest.mockReset()
    useConnectionStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    restComms.setCoreToken("core-token")
  })

  afterEach(() => {
    if (fakeTimersEnabled) {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })

  it("retries once after NO_ACTIVE_SESSION and waits for the next connected transition", async () => {
    const noActiveSessionError = {
      isAxiosError: true,
      response: {
        status: 503,
        data: {error: "NO_ACTIVE_SESSION"},
      },
    }
    mockRequest
      .mockRejectedValueOnce(noActiveSessionError)
      .mockResolvedValueOnce({data: {success: true, data: [{packageName: "com.demo"}]}})

    const noActiveSessionSpy = jest.fn()
    GlobalEventEmitter.on("NO_ACTIVE_SESSION", noActiveSessionSpy)

    const resultPromise = (async () => await restComms.getApplets())()

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(noActiveSessionSpy).toHaveBeenCalled())
    useConnectionStore.getState().setStatus(WebSocketStatus.DISCONNECTED)
    useConnectionStore.getState().setStatus(WebSocketStatus.CONNECTED)

    const result = await resultPromise

    expect(result.is_ok()).toBe(true)
    expect(result.value).toEqual([{packageName: "com.demo"}])
    expect(mockRequest).toHaveBeenCalledTimes(2)
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.objectContaining({Authorization: "Bearer core-token"}),
      }),
    )

    GlobalEventEmitter.off("NO_ACTIVE_SESSION", noActiveSessionSpy)
  })

  it("does not resolve against a stale already-connected state", async () => {
    useScopedFakeTimers()
    useConnectionStore.getState().setStatus(WebSocketStatus.CONNECTED)
    mockRequest.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 503,
        data: {error: "NO_ACTIVE_SESSION"},
      },
    })

    const resultPromise = (async () => await restComms.getApplets())()

    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1))

    useConnectionStore.getState().setStatus(WebSocketStatus.DISCONNECTED)
    jest.advanceTimersByTime(8_000)

    const result = await resultPromise
    expect(result.is_error()).toBe(true)
    expect(mockRequest).toHaveBeenCalledTimes(1)
  })

  it("syncs core tokens to native state", () => {
    const BluetoothSdk = require("@mentra/bluetooth-sdk-internal").default
    restComms.setCoreToken("new-core-token")

    expect(BluetoothSdk.updateBluetoothSettings).toHaveBeenCalledWith({core_token: "new-core-token"})
    expect(useSettingsStore.getState().getSetting(SETTINGS.core_token.key)).not.toBe("new-core-token")
  })
})
