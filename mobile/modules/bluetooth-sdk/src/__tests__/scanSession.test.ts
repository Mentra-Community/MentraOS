import {describe, expect, it} from "bun:test"
import {createScanSession} from "../_private/scanSession"
import {DeviceModels, type Device, type ScanDiagnostic} from "../BluetoothSdk.types"

const hint: ScanDiagnostic = {code: "device_connected_on_phone", message: "Matching glasses are connected."}
const model = DeviceModels.MentraLive
const setup = (getDiagnostic = async () => hint) => {
  const events: string[] = []
  let emit: (devices: Device[]) => void = () => {}
  const transport = {
    start: async () => {},
    stop: async () => {
      events.push("stop")
    },
    subscribe: (callback: typeof emit) => {
      emit = callback
      return () => {
        events.push("unsubscribe")
      }
    },
    getResults: async (): Promise<Device[]> => [],
    getDiagnostic,
  }
  const session = createScanSession(transport, {
    model,
    timeoutMs: 5,
    onDiagnostic: () => {
      events.push("diagnostic")
    },
  })
  return {...session, events, emit}
}
describe("scan advisory lifetime", () => {
  it("delivers a diagnostic before successful empty resolution", async () => {
    const s = setup()
    expect(await s.result).toEqual([])
    s.events.push("complete")
    expect(s.events).toEqual(["unsubscribe", "stop", "diagnostic", "complete"])
  })
  it("does not query on cancellation", async () => {
    let queried = false
    const s = setup(async () => {
      queried = true
      return hint
    })
    s.cancel()
    expect(await s.result).toEqual([])
    expect(queried).toBe(false)
  })
  it("suppresses a diagnostic if cancelled while its lookup is pending", async () => {
    let resolve!: (value: ScanDiagnostic) => void
    let queried!: () => void
    const started = new Promise<void>((r) => {
      queried = r
    })
    const s = setup(() => {
      queried()
      return new Promise((r) => {
        resolve = r
      })
    })
    await started
    s.cancel()
    resolve(hint)
    expect(await s.result).toEqual([])
    expect(s.events).not.toContain("diagnostic")
  })
  it("preserves empty completion when the platform diagnostic fails", async () => {
    const s = setup(async () => {
      throw new Error("permission revoked")
    })
    expect(await s.result).toEqual([])
  })
  it("does not query when the scan found a device", async () => {
    let queried = false
    const device: Device = {id: "one", model, name: "XyBLE_one"}
    const session = createScanSession(
      {
        start: async () => {},
        stop: async () => {},
        subscribe: () => () => {},
        getResults: async () => [device],
        getDiagnostic: async () => {
          queried = true
          return hint
        },
      },
      {model, timeoutMs: 5, onDiagnostic: () => {}},
    )
    expect(await session.result).toEqual([device])
    expect(queried).toBe(false)
  })
  it("works with an older native binary without a diagnostic method", async () => {
    const session = createScanSession(
      {
        start: async () => {},
        stop: async () => {},
        subscribe: () => () => {},
        getResults: async () => [],
      },
      {
        model,
        timeoutMs: 5,
        onDiagnostic: () => {
          throw new Error("unexpected hint")
        },
      },
    )
    expect(await session.result).toEqual([])
  })
  it("waits for a delayed native start to stop before cancellation completes", async () => {
    let releaseStart!: () => void
    const events: string[] = []
    const session = createScanSession(
      {
        start: () =>
          new Promise<void>((resolve) => {
            releaseStart = () => {
              events.push("started")
              resolve()
            }
          }),
        stop: async () => {
          events.push("stopped")
        },
        subscribe: () => () => {},
        getResults: async () => [],
      },
      {model, timeoutMs: 1000},
    )
    await Promise.resolve()
    const stopped = session.cancel().then(() => {
      events.push("cancelled")
    })
    expect(events).toEqual([])
    releaseStart()
    await stopped
    expect(events).toEqual(["started", "stopped", "cancelled"])
    expect(await session.result).toEqual([])
  })
  it("preserves start errors without querying diagnostics", async () => {
    const session = createScanSession(
      {
        start: async () => {
          throw new Error("Bluetooth unavailable")
        },
        stop: async () => {},
        subscribe: () => () => {},
        getResults: async () => [],
        getDiagnostic: async () => {
          throw new Error("must not query")
        },
      },
      {model, timeoutMs: 1000, onDiagnostic: () => {}},
    )
    await expect(session.result).rejects.toThrow("Bluetooth unavailable")
  })
})
