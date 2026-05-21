jest.mock("@/services/RestComms", () => ({
  __esModule: true,
  default: {
    updateGlassesState: jest.fn(),
  },
}))

type MockSocketInstance = {
  url: string
  send: jest.Mock
  close: jest.Mock
  onopen: (() => void) | null
  onmessage: ((event: {data: string | ArrayBuffer}) => void) | null
  onerror: ((event: any) => void) | null
  onclose: ((event: {code: number}) => void) | null
}

describe("WebSocketManager", () => {
  let instances: MockSocketInstance[]
  let manager: any
  let restComms: any
  let useConnectionStore: any
  let useGlassesStore: any

  beforeEach(() => {
    jest.resetModules()
    jest.useFakeTimers()
    instances = []

    global.WebSocket = jest.fn((url: string) => {
      const instance: MockSocketInstance = {
        url,
        send: jest.fn(),
        close: jest.fn(),
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      }
      instance.close.mockImplementation(() => {
        instance.onclose?.({code: 1000})
      })
      instances.push(instance)
      return instance as unknown as WebSocket
    }) as unknown as typeof WebSocket
    globalThis.WebSocket = global.WebSocket

    restComms = require("@/services/RestComms").default
    useConnectionStore = require("@/stores/connection").useConnectionStore
    useGlassesStore = require("@/stores/glasses").useGlassesStore
    useConnectionStore.getState().reset()
    useGlassesStore.getState().reset()
    useGlassesStore.getState().setGlassesInfo({connected: true, deviceModel: "Mentra Live"})
    manager = jest.requireActual("./WebSocketManager").default
  })

  afterEach(async () => {
    await manager?.cleanup?.()
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  async function flushPromises() {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve()
    }
  }

  async function connectAndOpen() {
    await manager.connect("wss://example.com/socket", "secret-token")
    expect(instances[0]).toBeDefined()
    instances[0].onopen?.()
  }

  it("reconnects when the pong timeout is missed", async () => {
    await connectAndOpen()

    expect(instances[0].send).toHaveBeenCalledWith(JSON.stringify({type: "ping"}))

    jest.advanceTimersByTime(5_000)
    await flushPromises()

    expect(global.WebSocket).toHaveBeenCalledTimes(2)
    expect(instances[0].close).toHaveBeenCalled()
    expect(instances[1].url).toContain("token=secret-token")
    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(restComms.updateGlassesState).toHaveBeenCalled()
  })

  it("reconnects after an error even if close never fires", async () => {
    await connectAndOpen()
    instances[0].onerror?.(new Error("boom"))

    expect(useConnectionStore.getState().status).toBe("error")

    jest.advanceTimersByTime(5_000)
    await flushPromises()

    expect(global.WebSocket).toHaveBeenCalledTimes(2)
  })

  it("does not reconnect after a manual disconnect", async () => {
    await connectAndOpen()
    await manager.disconnect()

    jest.advanceTimersByTime(15_000)
    await flushPromises()

    expect(global.WebSocket).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().status).toBe("disconnected")
  })
})
