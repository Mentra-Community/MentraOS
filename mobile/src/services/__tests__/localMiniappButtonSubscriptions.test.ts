/* eslint-disable no-restricted-imports, import/first */
import {MiniappStreamType} from "@mentra/miniapp"

jest.mock("react-native-share", () => ({__esModule: true, default: {open: jest.fn()}}))
jest.unmock("../../../modules/engine/src/services/LocalMiniappRuntime")

import localMiniappRuntime from "../../../modules/engine/src/services/LocalMiniappRuntime"

describe("LocalMiniappRuntime button subscriptions", () => {
  const packageName = "com.example.button-subscriber"

  afterEach(() => {
    localMiniappRuntime.unregisterApp(packageName)
  })

  it("publishes active subscription changes independently of app running state", () => {
    const changes: string[][] = []
    localMiniappRuntime.registerApp(packageName, jest.fn())
    const unsubscribe = localMiniappRuntime.onButtonPressSubscribersChanged((subscribers) => changes.push(subscribers))
    expect(localMiniappRuntime.getButtonPressSubscribers()).toEqual([])

    expect(localMiniappRuntime.subscribe(packageName, [MiniappStreamType.BUTTON_PRESS])).toEqual({ok: true})
    expect(localMiniappRuntime.getButtonPressSubscribers()).toEqual([packageName])
    expect(localMiniappRuntime.getDiagnosticSnapshot().subscriptionsByStream).toEqual({
      [MiniappStreamType.BUTTON_PRESS]: [packageName],
    })

    expect(localMiniappRuntime.subscribe(packageName, [])).toEqual({ok: true})
    expect(localMiniappRuntime.getButtonPressSubscribers()).toEqual([])

    unsubscribe()
    expect(changes).toEqual([[packageName], []])
  })
})
