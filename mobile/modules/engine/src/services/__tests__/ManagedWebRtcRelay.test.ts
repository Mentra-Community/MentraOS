import {describe, expect, mock, test} from "bun:test"
import "./bluetoothSdkTestMock"
import type {RelayDependencies} from "../ManagedWebRtcRelay"
import type {StreamStartRequest} from "@mentra/bluetooth-sdk/internal"
const {ManagedWebRtcRelay} = await import("../ManagedWebRtcRelay")
import {acquireGlassesHotspot} from "../GlassesHotspotLease"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return {promise, resolve, reject}
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

function harness(overrides: Partial<RelayDependencies> = {}) {
  const calls: string[] = []
  let listener: Parameters<RelayDependencies["native"]["addListener"]>[1] = () => {}
  const native = {
    prepare: mock(async (options: {attemptId: string}) => {
      calls.push(`prepare:${options.attemptId}`)
      return "http://192.168.43.2:8080/whip"
    }),
    stop: mock(async (id: string) => {
      calls.push(`native-stop:${id}`)
    }),
    addListener: mock((_name: string, cb: typeof listener) => {
      listener = cb
      return {remove: () => calls.push("unsubscribe")}
    }),
  }
  const failure = mock((_error: Error) => {})
  const status = mock((_state: string, _reason: string) => {})
  const startGlasses = mock(async (request: StreamStartRequest) => {
    calls.push(`publish:${request.streamId}`)
    return undefined
  })
  const deps: RelayDependencies = {
    native,
    startGlasses,
    hotspot: mock(async (on) => {
      calls.push(on ? "hotspot-on" : "hotspot-off")
      return {state: on ? "enabled" : "disabled", ssid: "glasses", password: "password"}
    }),
    stopGlasses: mock(async () => {
      calls.push("glasses-stop")
    }),
    connected: () => true,
    deferredStop: () => calls.push("deferred-stop"),
    sleep: async () => {},
    acquire: () => () => calls.push("release"),
    ...overrides,
  }
  const relay = new ManagedWebRtcRelay(
    {streamId: "phone-m-1", ingestUrl: "https://cloudflare.test/whip"},
    status,
    failure,
    deps,
  )
  const emit = (attempt = 1, state = "failed") =>
    listener({attemptId: `phone-m-1-relay-${attempt}`, state, reason: "lost network"})
  return {relay, deps, native, calls, emit, failure, status, startGlasses}
}

describe("ManagedWebRtcRelay", () => {
  test("Cloudflare credentials stay on the phone; glasses publish host-only to the local receiver", async () => {
    const h = harness()
    await h.relay.start()
    expect(h.native.prepare.mock.calls[0][0]).toMatchObject({
      ingestUrl: "https://cloudflare.test/whip",
      captureAudio: true,
    })
    expect(h.startGlasses.mock.calls[0][0]).toMatchObject({
      streamUrl: "http://192.168.43.2:8080/whip",
      ice: {stun: ""},
      captureAudio: true,
    })
    await h.relay.stop()
    expect(h.calls.slice(-5)).toEqual([
      "unsubscribe",
      "glasses-stop",
      "native-stop:phone-m-1-relay-1",
      "hotspot-off",
      "release",
    ])
  })

  test("stop during hotspot setup waits for its late success and turns it back off", async () => {
    const gate = deferred<{state: string; ssid: string; password: string}>()
    const h = harness({hotspot: async (on) => (on ? gate.promise : {state: "disabled"})})
    const start = h.relay.start().catch((error) => error)
    const stop = h.relay.stop()
    gate.resolve({state: "enabled", ssid: "glasses", password: "password"})
    expect(await start).toBeInstanceOf(Error)
    await stop
    expect(h.native.prepare).not.toHaveBeenCalled()
    expect(h.calls).toContain("release")
  })

  test("cancel during native prepare cleans a late receiver without starting the camera", async () => {
    const gate = deferred<string>()
    const h = harness()
    h.native.prepare.mockImplementationOnce(() => gate.promise)
    const start = h.relay.start().catch((error) => error)
    await tick()
    const stop = h.relay.stop()
    expect(h.native.stop).not.toHaveBeenCalled()
    gate.resolve("http://192.168.43.2/whip")
    await start
    await stop
    expect(h.native.stop).toHaveBeenCalledTimes(1)
    expect(h.startGlasses).not.toHaveBeenCalled()
  })

  test("a failed local or outgoing leg rebuilds both and ignores stale callbacks", async () => {
    const h = harness()
    await h.relay.start()
    h.emit()
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(2)
    expect(h.calls.indexOf("native-stop:phone-m-1-relay-1")).toBeLessThan(h.calls.indexOf("prepare:phone-m-1-relay-2"))
    h.emit(1)
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(2)
    expect(h.relay.owns("phone-m-1-relay-1")).toBe(true)
    await h.relay.stop()
  })

  test("stop wins over reconnect backoff", async () => {
    const gate = deferred<void>()
    const h = harness({sleep: (ms) => (ms === 1000 ? gate.promise : Promise.resolve())})
    await h.relay.start()
    h.emit()
    await tick()
    const stop = h.relay.stop()
    gate.resolve()
    await stop
    expect(h.native.prepare).toHaveBeenCalledTimes(1)
  })

  test("cleanup failure retains ownership and repeated stop retries the same attempt", async () => {
    const h = harness()
    await h.relay.start()
    h.native.stop.mockRejectedValueOnce(new Error("native still draining"))
    await expect(h.relay.stop()).rejects.toThrow("native still draining")
    expect(h.calls).not.toContain("release")
    await h.relay.stop()
    expect(h.native.stop.mock.calls.map(([id]) => id)).toEqual(["phone-m-1-relay-1", "phone-m-1-relay-1"])
    expect(h.calls).toContain("release")
  })

  test("failed hotspot shutdown is not erased by a second stop", async () => {
    let shutdownWorks = false
    const h = harness({
      hotspot: async (on) => ({
        state: on ? "enabled" : shutdownWorks ? "disabled" : "error",
        ssid: "glasses",
        password: "password",
      }),
    })
    await h.relay.start()
    await expect(h.relay.stop()).rejects.toThrow("shutdown")
    await expect(h.relay.stop()).rejects.toThrow("shutdown")
    expect(h.calls).not.toContain("release")
    shutdownWorks = true
    await h.relay.stop()
  })

  test("retry budget is finite and surfaces failure to the stream owner", async () => {
    const h = harness()
    await h.relay.start()
    for (let attempt = 1; attempt <= 4; attempt++) {
      h.emit(attempt)
      await tick()
    }
    expect(h.native.prepare).toHaveBeenCalledTimes(4)
    expect(h.failure).toHaveBeenCalledTimes(1)
    await h.relay.stop()
  })

  test("ACS and managed streaming cannot both acquire the hotspot", async () => {
    const releaseCall = acquireGlassesHotspot()
    const h = harness({acquire: acquireGlassesHotspot})
    expect(() => h.relay.start()).toThrow("already in use")
    expect(h.calls).toEqual([])
    releaseCall()
    const fresh = harness({acquire: acquireGlassesHotspot})
    await fresh.relay.start()
    await fresh.relay.stop()
    const releaseAgain = acquireGlassesHotspot()
    releaseAgain()
  })
})
