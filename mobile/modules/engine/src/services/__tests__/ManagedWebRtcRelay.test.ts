import {describe, expect, mock, test} from "bun:test"
import "./bluetoothSdkTestMock"
import type {RelayDependencies, RelayOptions} from "../ManagedWebRtcRelay"
import type {StreamStartRequest} from "@mentra/bluetooth-sdk/internal"
const {ManagedWebRtcRelay} = await import("../ManagedWebRtcRelay")
import type {GlassesWifiBinding, GlassesWifiEvent, GlassesWifiHold} from "@mentra/bluetooth-sdk/glasses-wifi"

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

const BINDING: GlassesWifiBinding = {ssid: "glasses", password: "password", gateway: "192.168.43.1", phoneIpv4: "192.168.43.2"}

/** A hold on the glasses Wi-Fi service whose link the test can drop and bring back. */
function fakeWifi(calls: string[]) {
  const listeners = new Set<(event: GlassesWifiEvent) => void>()
  let up = true
  const waiting: Array<(binding: GlassesWifiBinding) => void> = []
  const hold: GlassesWifiHold = {
    get binding() {
      return BINDING
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => (up ? Promise.resolve(BINDING) : new Promise((resolve) => waiting.push(resolve))),
    release: async () => {
      calls.push("release")
    },
  }
  return {
    hold,
    lose: () => {
      up = false
      listeners.forEach((listener) => listener({type: "lost", reason: "the glasses left Bluetooth"}))
    },
    restore: () => {
      up = true
      listeners.forEach((listener) => listener({type: "restored", binding: BINDING}))
      waiting.splice(0).forEach((resolve) => resolve(BINDING))
    },
  }
}

function harness(overrides: Partial<RelayDependencies> = {}, options: Partial<RelayOptions> = {}) {
  const calls: string[] = []
  const wifi = fakeWifi(calls)
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
    holdWifi: mock(async () => {
      calls.push("hold")
      return wifi.hold
    }),
    stopGlasses: mock(async () => {
      calls.push("glasses-stop")
    }),
    connected: () => true,
    deferredStop: () => calls.push("deferred-stop"),
    sleep: async () => {},
    now: Date.now,
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
  return {relay, deps, native, calls, emit, failure, status, startGlasses, wifi}
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
  test("native diagnostics do not change the user-visible stream lifecycle", async () => {
    const h = harness()
    await h.relay.start()
    h.emit(1, "diagnostic", "Posting WHIP offer (2 candidates)")
    expect(h.status).not.toHaveBeenCalled()
    expect(h.failure).not.toHaveBeenCalled()
    await h.relay.stop()
  })
  test("reconnection waits for the new native publisher, not the glasses start ACK", async () => {
    const h = harness()
    await h.relay.start()
    h.emit(1, "connected", "Phone publisher connected")
    h.emit(1)
    expect(h.status).toHaveBeenLastCalledWith("reconnecting", "lost network")
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(2)
    expect(h.status.mock.calls.filter(([state]) => state === "reconnected")).toHaveLength(0)
    h.emit(1, "connected", "late old connection")
    expect(h.status.mock.calls.filter(([state]) => state === "reconnected")).toHaveLength(0)
    h.emit(2, "connected", "Phone publisher connected")
    expect(h.status).toHaveBeenLastCalledWith("reconnected", "Phone publisher connected")
    h.emit(2, "connected", "duplicate ICE completed")
    expect(h.status.mock.calls.filter(([state]) => state === "reconnected")).toHaveLength(1)
    await h.relay.stop()
  })

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

  test("passes videoPassthrough to the native relay only when the caller asked for it", async () => {
    const asked = harness({}, {videoPassthrough: true})
    await asked.relay.start()
    expect(asked.native.prepare.mock.calls[0][0]).toMatchObject({videoPassthrough: true})
    await asked.relay.stop()

    const notAsked = harness({})
    await notAsked.relay.start()
    expect(notAsked.native.prepare.mock.calls[0][0]).not.toHaveProperty("videoPassthrough")
    await notAsked.relay.stop()

    const refused = harness({}, {videoPassthrough: false})
    await refused.relay.start()
    expect(refused.native.prepare.mock.calls[0][0]).not.toHaveProperty("videoPassthrough")
    await refused.relay.stop()
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

  test("a microphone source conflict fails before holding the glasses Wi-Fi or disabling WHIP audio", async () => {
    const mic = microphone()
    mic.acquire.mockImplementation(() => {
      throw new Error("MIC_SOURCE_CONFLICT")
    })
    const h = harness({microphone: mic})
    await expect(h.relay.start()).rejects.toThrow("MIC_SOURCE_CONFLICT")
    await h.relay.stop()
    expect(h.deps.holdWifi).not.toHaveBeenCalled()
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
      bindAddress: "192.168.43.2",
      captureAudio: true,
    })
    expect(h.startGlasses.mock.calls[0][0]).toMatchObject({
      streamUrl: "http://192.168.43.2:8080/whip",
      ice: {stun: ""},
      captureAudio: true,
    })
    await h.relay.stop()
    expect(h.calls.slice(-4)).toEqual(["unsubscribe", "glasses-stop", "native-stop:phone-m-1-relay-1", "release"])
  })

  test("stop during the Wi-Fi hold waits for it to land and gives it back", async () => {
    const gate = deferred<GlassesWifiHold>()
    const h = harness({holdWifi: () => gate.promise})
    const start = h.relay.start().catch((error) => error)
    const stop = h.relay.stop()
    gate.resolve(h.wifi.hold)
    expect(await start).toBeInstanceOf(Error)
    await stop
    expect(h.native.prepare).not.toHaveBeenCalled()
    expect(h.calls).toContain("release")
  })


  test("cancel interrupts a denied permission wait and retains the lease until native cleanup completes", async () => {
    const gate = deferred<string>()
    const cleanup = deferred<void>()
    const h = harness()
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
      expect(h.calls).not.toContain("release")
      // Ignore permission notifications from the cancelled native attempt.
      h.emit(1, "permission_required")
      expect(h.status).toHaveBeenCalledTimes(1)
      cleanup.resolve()
      await stop
      expect(h.native.stop).toHaveBeenCalledTimes(1)
      expect(h.startGlasses).not.toHaveBeenCalled()
      expect(h.calls).toContain("release")
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

  test("retries keep the one Wi-Fi hold for the whole stream", async () => {
    const sleeps: number[] = []
    const h = harness({sleep: async (ms) => void sleeps.push(ms)})
    await h.relay.start()
    h.emit(1, "failed", "Glasses receiver: frames_stalled")
    await tick()
    h.emit(2)
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(3)
    expect(h.deps.holdWifi).toHaveBeenCalledTimes(1)
    expect(h.calls).not.toContain("release")
    expect(sleeps).toEqual([1_000, 2_000]) // backoff only
    await h.relay.stop()
    expect(h.calls).toContain("release")
  })


  test("a lost link fails the attempt, and the retry waits for the service to bring it back", async () => {
    const h = harness()
    await h.relay.start()
    h.wifi.lose()
    expect(h.status).toHaveBeenLastCalledWith("reconnecting", "Glasses Wi-Fi link lost: the glasses left Bluetooth")
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(1)
    h.wifi.restore()
    await tick()
    expect(h.native.prepare).toHaveBeenCalledTimes(2)
    await h.relay.stop()
  })


  test("a failure that lands right after a restart returns is still retried", async () => {
    // The window between startAttempt returning and `restarting` clearing is a few microtasks, so
    // sweep the delay at which the native layer reports the new attempt dead.
    for (let depth = 0; depth < 12; depth++) {
      const h = harness()
      const original = h.deps.startGlasses
      h.deps.startGlasses = mock(async (request: StreamStartRequest) => {
        const result = await original(request)
        if (request.streamId.endsWith("relay-2")) {
          let chain: Promise<unknown> = Promise.resolve()
          for (let i = 0; i < depth; i++) chain = chain.then(() => {})
          void chain.then(() => h.emit(2))
        }
        return result
      })
      await h.relay.start()
      h.emit(1)
      await tick()
      await tick()
      expect(h.native.prepare.mock.calls.length).toBeGreaterThanOrEqual(3)
      await h.relay.stop()
    }
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
      h.emit(attempt, "connected", "Phone publisher connected")
      now += 60_000
      h.emit(attempt)
      await tick()
    }
    expect(h.native.prepare).toHaveBeenCalledTimes(6)
    expect(h.failure).not.toHaveBeenCalled()
    await h.relay.stop()
  })

})
