/* eslint-disable no-restricted-imports, import/first */
import {MiniappStreamType} from "@mentra/miniapp"

jest.mock("react-native-share", () => ({__esModule: true, default: {open: jest.fn()}}))
jest.unmock("../../../modules/engine/src/services/LocalMiniappRuntime")

import localMiniappRuntime from "../../../modules/engine/src/services/LocalMiniappRuntime"

describe("LocalMiniappRuntime forwardEvent", () => {
  const packageName = "com.example.glasses-connection-subscriber"

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(async () => {
    try {
      localMiniappRuntime.unregisterApp(packageName)
      // Unregistering releases microphone requirements through a debounced write.
      // Finish that teardown before Jest disposes this test's environment.
      await jest.runOnlyPendingTimersAsync()
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not forward partial battery deltas on glasses_connection_state as connection events", () => {
    const sendFn = jest.fn()
    localMiniappRuntime.registerApp(packageName, sendFn)
    localMiniappRuntime.subscribe(packageName, [MiniappStreamType.GLASSES_CONNECTION])

    localMiniappRuntime.forwardEvent("glasses_connection_state", {
      batteryLevel: 80,
      charging: false,
    })

    expect(sendFn).not.toHaveBeenCalled()
  })
})
