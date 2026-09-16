/* eslint-disable no-restricted-imports, import/first */
import {AppState, type AppStateStatus} from "react-native"
import {MiniappRequestType, MiniappResponseType, parseEnvelope, serializeEnvelope} from "@mentra/miniapp"

jest.mock("react-native-share", () => ({__esModule: true, default: {open: jest.fn()}}))
jest.unmock("../../../modules/engine/src/services/LocalMiniappRuntime")

import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import localMiniappRuntime from "../../../modules/engine/src/services/LocalMiniappRuntime"
import {useAppStatusStore} from "../../../modules/engine/src/stores/apps"

describe("LocalMiniappRuntime visibility", () => {
  const appA = "com.example.visibility-a"
  const appB = "com.example.visibility-b"
  const messages: Array<{packageName: string; type: unknown; visibility: unknown}> = []
  const listeners = new Set<(state: AppStateStatus) => void>()
  let originalAppState: AppStateStatus
  let originalForeground: string | null

  beforeEach(() => {
    jest.useFakeTimers()
    originalAppState = AppState.currentState
    originalForeground = useAppStatusStore.getState().foregroundedPackage
    AppState.currentState = "active"
    useAppStatusStore.setState({foregroundedPackage: null})
    jest.spyOn(cloudClientService, "hasCore").mockReturnValue(false)
    jest.spyOn(AppState, "addEventListener").mockImplementation((event, listener) => {
      if (event === "change") listeners.add(listener)
      return {remove: () => listeners.delete(listener)}
    })
    localMiniappRuntime.initialize()
    messages.length = 0
  })

  afterEach(() => {
    localMiniappRuntime.cleanup()
    useAppStatusStore.setState({foregroundedPackage: originalForeground})
    AppState.currentState = originalAppState
    listeners.clear()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function register(packageName: string) {
    localMiniappRuntime.registerApp(packageName, (raw) => {
      const payload = parseEnvelope(raw)?.payload as Record<string, unknown> | undefined
      if (payload) messages.push({packageName, type: payload.type, visibility: payload.visibility})
    })
  }

  async function connect(packageName: string) {
    localMiniappRuntime.handleRawMessage(
      packageName,
      serializeEnvelope({payload: {type: MiniappRequestType.CONNECT}, requestId: "connect-test"}),
    )
    // CONNECT_ACK is immediate; flush any asynchronous follow-up delivery.
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  function edges() {
    return messages
      .filter((message) => message.type === MiniappResponseType.VISIBILITY_CHANGE)
      .map(({packageName, visibility}) => [packageName, visibility])
  }

  function hostState(state: AppStateStatus) {
    AppState.currentState = state
    listeners.forEach((listener) => listener(state))
  }

  it("seeds CONNECT_ACK and emits only actual foreground edges", async () => {
    useAppStatusStore.setState({foregroundedPackage: appA})
    register(appA)
    register(appB)
    await connect(appA)
    await connect(appB)
    expect(
      messages
        .filter((message) => message.type === MiniappResponseType.CONNECT_ACK)
        .map(({packageName, visibility}) => [packageName, visibility]),
    ).toEqual([
      [appA, "foreground"],
      [appB, "background"],
    ])
    expect(edges()).toEqual([])

    useAppStatusStore.setState({foregroundedPackage: appB})
    useAppStatusStore.setState({foregroundedPackage: appB})
    useAppStatusStore.setState({apps: [...useAppStatusStore.getState().apps]})
    useAppStatusStore.setState({foregroundedPackage: null})
    useAppStatusStore.setState({foregroundedPackage: appA})
    expect(edges()).toEqual([
      [appA, "background"],
      [appB, "foreground"],
      [appB, "background"],
      [appA, "foreground"],
    ])
  })

  it("backgrounds once when the host leaves and foregrounds only the latest selected app on resume", async () => {
    useAppStatusStore.setState({foregroundedPackage: appA})
    register(appA)
    register(appB)
    await connect(appA)
    await connect(appB)
    hostState("inactive")
    hostState("background")
    useAppStatusStore.setState({foregroundedPackage: appB})
    hostState("active")
    hostState("active")
    expect(edges()).toEqual([
      [appA, "background"],
      [appB, "foreground"],
    ])
  })

  it("seeds a selected app as background when CONNECT completes while the host is backgrounded", async () => {
    useAppStatusStore.setState({foregroundedPackage: appA})
    hostState("background")
    register(appA)
    await connect(appA)
    expect(messages.find((message) => message.type === MiniappResponseType.CONNECT_ACK)?.visibility).toBe("background")
    hostState("active")
    expect(edges()).toEqual([[appA, "foreground"]])
  })

  it("delivers visibility after the immediate ACK while auth remains pending", async () => {
    let rejectAuth!: (reason?: unknown) => void
    jest.mocked(cloudClientService.hasCore).mockReturnValue(true)
    jest.spyOn(cloudClientService, "getMiniappAuthToken").mockReturnValue(
      new Promise<never>((_, reject) => {
        rejectAuth = reject
      }),
    )
    register(appA)
    await connect(appA)
    expect(messages.find((message) => message.type === MiniappResponseType.CONNECT_ACK)?.visibility).toBe("background")
    useAppStatusStore.setState({foregroundedPackage: appA})
    expect(edges()).toEqual([[appA, "foreground"]])
    rejectAuth(new Error("offline fixture"))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(messages.filter((message) => message.type === MiniappResponseType.CONNECT_ACK)).toHaveLength(1)
    expect(edges()).toEqual([[appA, "foreground"]])
  })

  it("does not deliver an old registration's delayed ACK to its replacement", async () => {
    let rejectAuth!: (reason?: unknown) => void
    jest.mocked(cloudClientService.hasCore).mockReturnValue(true)
    jest.spyOn(cloudClientService, "getMiniappAuthToken").mockReturnValue(
      new Promise<never>((_, reject) => {
        rejectAuth = reject
      }),
    )
    register(appA)
    await connect(appA)
    register(appA)
    messages.length = 0
    rejectAuth(new Error("old connection"))
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(messages.filter((message) => message.type === MiniappResponseType.CONNECT_ACK)).toEqual([])
    useAppStatusStore.setState({foregroundedPackage: appA})
    expect(edges()).toEqual([])
  })

  it("removes observers on cleanup and can initialize again without duplication", async () => {
    localMiniappRuntime.initialize()
    register(appA)
    await connect(appA)
    localMiniappRuntime.unregisterApp(appA)
    useAppStatusStore.setState({foregroundedPackage: appA})
    expect(edges()).toEqual([])
    localMiniappRuntime.cleanup()
    expect(listeners.size).toBe(0)
    localMiniappRuntime.initialize()
    localMiniappRuntime.initialize()
    expect(listeners.size).toBe(1)
    register(appA)
    await connect(appA)
    messages.length = 0
    useAppStatusStore.setState({foregroundedPackage: null})
    expect(edges()).toEqual([[appA, "background"]])
  })
})
