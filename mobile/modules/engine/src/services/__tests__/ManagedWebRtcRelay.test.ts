import {describe, expect, mock, test} from "bun:test"
import "./bluetoothSdkTestMock"
import type {RelayDependencies, RelayOptions} from "../ManagedWebRtcRelay"
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

function harness(overrides: Partial<RelayDependencies> = {}, options: Partial<RelayOptions> = {}) {
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
    pushOutgoingPcm: mock((_id: string, _pcm: string, _rate: number, _channels: number) => true),
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
      return {state: on ? "enabled" : "disabled", ssid: "glasses", password: "password", localIp: "192.168.43.1"}
    }),
    stopGlasses: mock(async () => {
      calls.push("glasses-stop")
    }),
    connected: () => true,
    deferredStop: () => calls.push("deferred-stop"),
    sleep: async () => {},
    now: Date.now,
    acquire: () => () => calls.push("release"),
    ...overrides,
  }
  const relay = new ManagedWebRtcRelay(
    {streamId: "phone-m-1", ingestUrl: "https://cloudflare.test/whip", ...options},
    status,
    failure,
    deps,
  )
  const emit = (attempt = 1, state = "failed", reason = "lost network") =>
    listener({attemptId: `phone-m-1-relay-${attempt}`, state, reason})
  return {relay, deps, native, calls, emit, failure, status, startGlasses}
}

function microphone() {
  const listeners: Array<Parameters<NonNullable<RelayDependencies["microphone"]>["subscribe"]>[0]> = []
  const release = mock(() => {})
  const remove = mock(() => {})
  return {
    listeners,
    release,
    remove,
    acquire: mock(() => release),
    subscribe: mock((listener: (typeof listeners)[number]) => {
      listeners.push(listener)
      return {remove}
    }),
  }
}

describe("ManagedWebRtcRelay", () => {
  test("BLE LC3 feeds the phone publisher while glasses capture video only", async () => {
    const mic = microphone()
    const h = harness({microphone: mic})
    await h.relay.start()
    expect(mic.acquire).toHaveBeenCalledTimes(1)
    expect(h.native.prepare.mock.calls[0][0]).toMatchObject({captureAudio: true, audioTransport: "ble-lc3"})
    expect(h.startGlasses.mock.calls[0][0].captureAudio).toBe(false)
    mic.listeners[0]({source: "glasses", pcm: new Uint8Array([0, 127, 255, 128]).buffer, sampleRate: 16000})
    expect(h.native.pushOutgoingPcm).toHaveBeenCalledWith("phone-m-1-relay-1", "AH//gA==", 16000, 1)
    await h.relay.stop()
    expect(mic.remove).toHaveBeenCalledTimes(1)
    expect(mic.release).toHaveBeenCalledTimes(1)
    mic.listeners[0]({source: "glasses", pcm: new ArrayBuffer(4)})
    expect(h.native.pushOutgoingPcm).toHaveBeenCalledTimes(1)
  })

  test("explicit video-only capture never acquires or publishes microphone audio", async () => {
    const mic = microphone()
    const h = harness({microphone: mic}, {captureAudio: false})
    await h.relay.start()
    expect(mic.acquire).not.toHaveBeenCalled()
    expect(h.native.prepare.mock.calls[0][0]).toMatchObject({captureAudio: false, audioTransport: "none"})
    expect(h.startGlasses.mock.calls[0][0].captureAudio).toBe(false)
    await h.relay.stop()
  })

  test("an older native publisher retains WHIP audio instead of losing the microphone", async () => {
    const mic = microphone()
    const h = harness({microphone: mic})
    h.deps.native.pushOutgoingPcm = undefined
    await h.relay.start()
    expect(mic.acquire).not.toHaveBeenCalled()
    expect(h.native.prepare.mock.calls[0][0]).toMatchObject({captureAudio: true, audioTransport: "whip"})
    expect(h.startGlasses.mock.calls[0][0].captureAudio).toBe(true)
    await h.relay.stop()
  })

  test("failed preparation releases the microphone during coordinator cleanup", async () => {
    const mic = microphone()
    const h = harness({microphone: mic})
    h.native.prepare.mockImplementation(async () => {
      throw new Error("prepare failed")
    })
    await expect(h.relay.start()).rejects.toThrow("prepare failed")
    await h.relay.stop()
    expect(mic.release).toHaveBeenCalledTimes(1)
    expect(mic.subscribe).not.toHaveBeenCalled()
  })

  test("retry replaces the microphone lease and rejects callbacks from its predecessor", async () => {
    const mic = microphone()
    const h = harness({microphone: mic})
    await h.relay.start()
    h.emit()
    await tick()
    expect(mic.acquire).toHaveBeenCalledTimes(2)
    expect(mic.release).toHaveBeenCalledTimes(1)
    const frame = {source: "glasses", pcm: new ArrayBuffer(4)}
    mic.listeners[0](frame)
    expect(h.native.pushOutgoingPcm).not.toHaveBeenCalled()
    mic.listeners[1](frame)
    expect(h.native.pushOutgoingPcm.mock.calls[0][0]).toBe("phone-m-1-relay-2")
    await h.relay.stop()
    expect(mic.release).toHaveBeenCalledTimes(2)
  })

  test("cancelling during preparation releases the mic without starting glasses capture", async () => {
    const mic = microphone()
    const prepared = deferred<string>()
    const h = harness({microphone: mic})
    h.native.prepare.mockImplementation(() => prepared.promise)
    const started = h.relay.start()
    await tick()
    const stopped = h.relay.stop()
    prepared.resolve("http://192.168.43.2:8080/whip")
    await expect(started).rejects.toThrow("cancelled")
    await stopped
    expect(mic.release).toHaveBeenCalledTimes(1)
    expect(mic.subscribe).not.toHaveBeenCalled()
    expect(h.startGlasses).not.toHaveBeenCalled()
  })

  test("a microphone source conflict fails before starting the hotspot or disabling WHIP audio", async () => {
    const mic = microphone()
    mic.acquire.mockImplementation(() => {
      throw new Error("MIC_SOURCE_CONFLICT")
    })
    const h = harness({microphone: mic})
    await expect(h.relay.start()).rejects.toThrow("MIC_SOURCE_CONFLICT")
    await h.relay.stop()
    expect(h.deps.hotspot).not.toHaveBeenCalled()
    expect(h.startGlasses).not.toHaveBeenCalled()
    expect(mic.release).not.toHaveBeenCalled()
  })

  test("phone microphone frames never enter a stream that selected glasses audio", async () => {
    const mic = microphone()
    const h = harness({microphone: mic})
    await h.relay.start()
    mic.listeners[0]({source: "phone", pcm: new ArrayBuffer(4)})
    expect(h.native.pushOutgoingPcm).not.toHaveBeenCalled()
    await h.relay.stop()
    expect(mic.release).toHaveBeenCalledTimes(1)
  })

  test("Cloudflare credentials stay on the phone; glasses publish host-only to the local receiver", async () => {
    const h = harness()
    await h.relay.start()
    expect(h.native.prepare.mock.calls[0][0]).toMatchObject({
      ingestUrl: "https://cloudflare.test/whip",
      gatewayAddress: "192.168.43.1",
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

  test("cancel interrupts a denied permission wait and retains the lease until native cleanup completes", async () => {
    const gate = deferred<string>()
    const cleanup = deferred<void>()
    const h = harness({acquire: acquireGlassesHotspot})
    h.native.prepare.mockImplementationOnce(() => gate.promise)
    h.native.stop.mockImplementationOnce(async (id) => {
      h.calls.push(`native-stop:${id}`)
      gate.reject(new Error("Relay cancelled"))
      await cleanup.promise
    })
    const start = h.relay.start().catch((error) => error)
    await tick()
    h.emit(1, "permission_required", "Allow Local Network access")
    expect(h.status).toHaveBeenCalledWith("permission_required", "Allow Local Network access")
    // The coordinator calls cancel before its transition can reach stop().
    h.relay.cancel()
    const stop = h.relay.stop()
    try {
      expect(h.relay.stop()).toBe(stop)
      expect(h.native.stop).toHaveBeenCalledTimes(1)
      expect(await start).toBeInstanceOf(Error)
      expect(() => acquireGlassesHotspot()).toThrow("already in use")
      expect(h.calls).not.toContain("hotspot-off")
      expect(h.calls).not.toContain("release")
      // Ignore permission notifications from the cancelled native attempt.
      h.emit(1, "permission_required")
      expect(h.status).toHaveBeenCalledTimes(1)
      cleanup.resolve()
      await stop
      expect(h.native.stop).toHaveBeenCalledTimes(1)
      expect(h.startGlasses).not.toHaveBeenCalled()
      expect(h.calls).toContain("hotspot-off")
      const release = acquireGlassesHotspot()
      release()
    } finally {
      gate.reject(new Error("test cleanup"))
      cleanup.resolve()
      await stop
    }
  })

  test("approval racing cancellation cannot start the glasses before native cleanup finishes", async () => {
    const gate = deferred<string>()
    const cleanup = deferred<void>()
    const h = harness()
    h.native.prepare.mockImplementationOnce(() => gate.promise)
    h.native.stop.mockImplementationOnce(() => cleanup.promise)
    const start = h.relay.start().catch((error) => error)
    await tick()
    const stop = h.relay.stop()
    try {
      // A successful prepare was already crossing the bridge when Cancel arrived.
      gate.resolve("http://192.168.43.2/whip")
      expect(await start).toBeInstanceOf(Error)
      expect(h.startGlasses).not.toHaveBeenCalled()
      expect(h.calls).not.toContain("release")
      cleanup.resolve()
      await stop
      expect(h.native.stop).toHaveBeenCalledTimes(1)
      expect(h.calls).toContain("hotspot-off")
      expect(h.calls).toContain("release")
    } finally {
      gate.reject(new Error("test cleanup"))
      cleanup.resolve()
      await stop
    }
  })

  test("failed prepare cancellation retains ownership and a second stop retries cleanup", async () => {
    const gate = deferred<string>()
    const h = harness()
    h.native.prepare.mockImplementationOnce(() => gate.promise)
    h.native.stop.mockImplementationOnce(async () => {
      gate.reject(new Error("Relay cancelled"))
      throw new Error("native cleanup failed")
    })
    const start = h.relay.start().catch((error) => error)
    await tick()
    await expect(h.relay.stop()).rejects.toThrow("native cleanup failed")
    expect(await start).toBeInstanceOf(Error)
    expect(h.calls).not.toContain("release")
    expect(h.calls).not.toContain("hotspot-off")
    await h.relay.stop()
    expect(h.native.stop).toHaveBeenCalledTimes(2)
    expect(h.calls).toContain("release")
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

  test("a minute of stable streaming renews the reconnect budget", async () => {
    let now = 0
    const h = harness({now: () => now})
    await h.relay.start()
    for (let attempt = 1; attempt <= 5; attempt++) {
      now += 60_000
      h.emit(attempt)
      await tick()
    }
    expect(h.native.prepare).toHaveBeenCalledTimes(6)
    expect(h.failure).not.toHaveBeenCalled()
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
