/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

type Status = {state: "enabled" | "disabled"; ssid?: string; password?: string; localIp?: string}
type Answer = Status | Error | {code: string}

// The glasses: each hotspot command takes the next scripted answer, else the requested state.
const commands: boolean[] = []
let script: Answer[] = []
const hotspotListeners = new Set<(event: {state: string}) => void>()
const ENABLED: Status = {state: "enabled", ssid: "MentraLive_abc123", password: "pw", localIp: "192.168.43.1"}
mock.module("@mentra/bluetooth-sdk", () => ({
  default: {
    setHotspotState: async (enabled: boolean) => {
      commands.push(enabled)
      const answer = script.shift()
      if (answer instanceof Error) throw answer
      if (answer && "code" in answer) throw Object.assign(new Error("session changed"), {code: answer.code})
      return answer ?? (enabled ? ENABLED : {state: "disabled"})
    },
    addListener: (_event: string, listener: (event: {state: string}) => void) => {
      hotspotListeners.add(listener)
      return {remove: () => hotspotListeners.delete(listener)}
    },
  },
  isEnabledHotspotStatus: (status: Status) => status.state === "enabled",
}))

// The BLE link: connected and ready unless a test says otherwise.
let connection = {state: "connected", fullyBooted: true}
const storeListeners = new Set<(connection: typeof connection) => void>()
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({connection}),
    subscribe: (_select: unknown, listener: (connection: {state: string; fullyBooted: boolean}) => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    },
  },
}))
mock.module("../GlassesReadiness", () => ({
  isGlassesConnected: (c: {state: string}) => c.state === "connected",
  isGlassesReady: (c: {state: string; fullyBooted: boolean}) => c.state === "connected" && c.fullyBooted,
}))
const setLink = (state: string, fullyBooted = state === "connected") => {
  connection = {state, fullyBooted}
  storeListeners.forEach((listener) => listener(connection))
}

// Timers run at once: waits are about order here, not time.
let now = 1_000_000
const realNow = Date.now
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void) => setTimeout(callback, 0) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
  },
}))

// The phone's one native join.
let wifiDirect = false
let directJoins = 0
let joins = 0
let joinAnswers: Array<string | Error | Promise<string>> = []
let disconnects = 0
const lostListeners = new Set<() => void>()
mock.module("../asg/localNetworkTransport", () => ({
  localNetworkTransport: {
    connect: async () => {
      joins++
      const answer = joinAnswers.shift() ?? "192.168.43.20"
      if (answer instanceof Error) throw answer
      return answer
    },
    wifiDirectAvailable: () => wifiDirect,
    connectWifiDirect: async () => {
      directJoins++
      return {ssid: "DIRECT-ML-abcd", localAddress: "192.168.43.50", gateway: "192.168.43.1"}
    },
    disconnect: async () => {
      disconnects++
    },
    onLost: (listener: () => void) => {
      lostListeners.add(listener)
      return () => lostListeners.delete(listener)
    },
  },
}))

const {GlassesWifiError, holdGlassesWifi, reclaimLateHotspot, LATE_ENABLE_WINDOW_MS, RESTORE_DEADLINE_MS} =
  await import("../GlassesWifi")
const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  commands.length = 0
  script = []
  joins = 0
  directJoins = 0
  wifiDirect = false
  joinAnswers = []
  disconnects = 0
  connection = {state: "connected", fullyBooted: true}
  now = 1_000_000
  Date.now = () => now
})
afterEach(() => {
  Date.now = realNow
})

describe("one shared link", () => {
  test("the first holder brings the link up, the second shares it, and the last release takes it down", async () => {
    const gallery = await holdGlassesWifi({consumer: "gallery"})
    expect(gallery.binding).toEqual({
      ssid: "MentraLive_abc123",
      password: "pw",
      gateway: "192.168.43.1",
      phoneIpv4: "192.168.43.20",
      frequency: undefined,
    })
    const call = await holdGlassesWifi({consumer: "call"})
    expect(call.binding.phoneIpv4).toBe("192.168.43.20")
    expect(commands).toEqual([true])
    expect(joins).toBe(1)

    await gallery.release()
    expect(commands).toEqual([true])
    await call.release()
    await call.release()
    expect(commands).toEqual([true, false])
    expect(disconnects).toBe(1)
  })

  test("a holder arriving while the link comes up waits for the same join", async () => {
    let finish!: (address: string) => void
    joinAnswers = [new Promise<string>((resolve) => (finish = resolve))]
    const first = holdGlassesWifi({consumer: "ota"})
    const second = holdGlassesWifi({consumer: "relay"})
    await settle()
    finish("192.168.43.30")
    const [a, b] = await Promise.all([first, second])
    expect(a.binding.phoneIpv4).toBe("192.168.43.30")
    expect(b.binding.phoneIpv4).toBe("192.168.43.30")
    expect(joins).toBe(1)
    await a.release()
    await b.release()
  })

  test("a hold that fails gives the link back", async () => {
    joinAnswers = [Object.assign(new Error("denied"), {code: "SOFTAP_PERMISSION_DENIED"})]
    const error = await holdGlassesWifi({consumer: "gallery"}).catch((e) => e)
    expect(error).toBeInstanceOf(GlassesWifiError)
    expect(error.stage).toBe("join")
    expect(error.code).toBe("SOFTAP_PERMISSION_DENIED")
    await settle()
    expect(commands).toEqual([true, false])
  })

  test("a glasses hotspot that will not start fails at the enable stage", async () => {
    script = [{state: "disabled"}, {state: "disabled"}, {state: "disabled"}]
    const error = await holdGlassesWifi({consumer: "gallery"}).catch((e) => e)
    expect(error).toBeInstanceOf(GlassesWifiError)
    expect(error.stage).toBe("enable")
    expect(joins).toBe(0)
  })
})

describe("bringing the link up", () => {
  test("an unanswered enable is asked again, never turned off", async () => {
    script = [new Error("Request timed out waiting for glasses response.")]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(commands).toEqual([true, true])
    await hold.release()
  })

  test("an enable answered 'disabled' is turned off and started once more", async () => {
    script = [{state: "disabled"}]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(commands).toEqual([true, false, true])
    await hold.release()
  })

  test("a command a restarting ASG dropped is re-sent once", async () => {
    script = [{code: "wifi_session_restarted"}]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(commands).toEqual([true, true])
    await hold.release()
  })

  test("an Unavailable join cycles the glasses hotspot and joins again", async () => {
    joinAnswers = [Object.assign(new Error("SSID not in scan"), {code: "SOFTAP_UNAVAILABLE"})]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(commands).toEqual([true, false, true])
    expect(joins).toBe(2)
    await hold.release()
  })

  test("other join failures are not retried", async () => {
    joinAnswers = [new Error("VPN")]
    await expect(holdGlassesWifi({consumer: "call"})).rejects.toThrow("VPN")
    expect(joins).toBe(1)
  })

  test("the first holder's explanation runs before the join, and an abort gives the hold back", async () => {
    const order: string[] = []
    const controller = new AbortController()
    const holding = holdGlassesWifi({
      consumer: "gallery",
      signal: controller.signal,
      beforeJoin: async (ssid) => {
        order.push(`explain ${ssid}`)
        controller.abort()
      },
    })
    await expect(holding).rejects.toThrow("cancelled")
    expect(order).toEqual(["explain MentraLive_abc123"])
    expect(commands.at(-1)).toBe(false)
  })
})

describe("cancelling a hold", () => {
  test("a hold cancelled before the join settles at once and never starts the join", async () => {
    let answer!: (status: Status) => void
    script = [new Promise<Status>((resolve) => (answer = resolve)) as unknown as Status]
    const controller = new AbortController()
    const holding = holdGlassesWifi({consumer: "relay", signal: controller.signal})
    await settle()
    controller.abort()
    await expect(holding).rejects.toThrow("cancelled")
    answer(ENABLED)
    await settle()
    expect(joins).toBe(0)
    expect(commands.at(-1)).toBe(false)
  })
})

describe("the first holder's explanation", () => {
  test("cancelling while it waits releases the link at once", async () => {
    const controller = new AbortController()
    const holding = holdGlassesWifi({
      consumer: "gallery",
      signal: controller.signal,
      beforeJoin: () => new Promise<void>(() => {}),
    })
    await settle()
    controller.abort()
    await expect(holding).rejects.toThrow("cancelled")
    await settle()
    expect(joins).toBe(0)
    expect(commands).toEqual([true, false])
    const next = await holdGlassesWifi({consumer: "ota"})
    await next.release()
  })

  test("cancelling it leaves another holder's join going", async () => {
    const controller = new AbortController()
    let acknowledge!: () => void
    const gallery = holdGlassesWifi({
      consumer: "gallery",
      signal: controller.signal,
      beforeJoin: () =>
        new Promise<void>((_, reject) => {
          acknowledge = () => reject(new Error("Gallery sync aborted"))
        }),
    }).catch((error: Error) => error)
    await settle()
    const call = holdGlassesWifi({consumer: "call"})
    controller.abort()
    acknowledge()
    expect(await gallery).toBeInstanceOf(Error)
    const held = await call
    expect(held.binding.phoneIpv4).toBe("192.168.43.20")
    await held.release()
  })
})

describe("losing and restoring the link", () => {
  test("glasses that restart are asked again once ready, and holders hear lost then restored", async () => {
    const hold = await holdGlassesWifi({consumer: "ota"})
    const events: string[] = []
    hold.onChange((event) =>
      events.push(event.type === "restored" ? `restored ${event.binding.phoneIpv4}` : event.type),
    )
    joinAnswers = ["192.168.43.40"]

    setLink("disconnected")
    expect(events).toEqual(["lost"])
    setLink("connected", false)
    await settle()
    expect(commands).toEqual([true])
    setLink("connected", true)
    await settle()
    expect(events).toEqual(["lost", "restored 192.168.43.40"])
    expect(hold.binding.phoneIpv4).toBe("192.168.43.40")
    expect(await hold.ready()).toEqual(hold.binding)
    await hold.release()
  })

  test("the phone leaving the network is a loss, and the link comes back while the glasses stay", async () => {
    const hold = await holdGlassesWifi({consumer: "gallery"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    const ready = hold.ready()
    lostListeners.forEach((listener) => listener())
    await settle()
    expect(events).toEqual(["lost", "restored"])
    await ready
    expect(joins).toBe(2)
    await hold.release()
  })

  test("glasses that turn their hotspot off are a loss", async () => {
    const hold = await holdGlassesWifi({consumer: "call"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    hotspotListeners.forEach((listener) => listener({state: "disabled"}))
    await settle()
    expect(events).toEqual(["lost", "restored"])
    await hold.release()
  })

  test("glasses that do not come back in time end the link", async () => {
    const hold = await holdGlassesWifi({consumer: "relay"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    setLink("disconnected")
    const ready = hold.ready().catch((error: Error) => error.message)
    now += RESTORE_DEADLINE_MS + 1
    setLink("connected", true)
    await settle()
    expect(events).toEqual(["lost", "ended"])
    expect(await ready).toBe("the glasses did not bring the link back")
    await hold.release()
  })

  test("glasses that stay away end the link at the deadline, and ready() then rejects", async () => {
    const hold = await holdGlassesWifi({consumer: "gallery"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    setLink("disconnected")
    now += RESTORE_DEADLINE_MS + 1
    await settle()
    expect(events).toEqual(["lost", "ended"])
    await expect(hold.ready()).rejects.toThrow("did not bring the link back")
    await hold.release()
  })

  test("a released link is not restored", async () => {
    const hold = await holdGlassesWifi({consumer: "gallery"})
    setLink("disconnected")
    await hold.release()
    setLink("connected", true)
    await settle()
    expect(joins).toBe(1)
  })
})

describe("a late hotspot", () => {
  test("an enabled report soon after the last release is turned off; later ones are left alone", async () => {
    const hold = await holdGlassesWifi({consumer: "gallery"})
    expect(await reclaimLateHotspot()).toBe(false)
    await hold.release()
    commands.length = 0
    expect(await reclaimLateHotspot()).toBe(true)
    expect(commands).toEqual([false])
    now += LATE_ENABLE_WINDOW_MS
    expect(await reclaimLateHotspot()).toBe(false)
  })
})

describe("the Wi-Fi Direct link", () => {
  test("glasses and a phone that can hold a group get it instead of the hotspot, and its release sends no hotspot command", async () => {
    wifiDirect = true
    const gallery = await holdGlassesWifi({consumer: "gallery"})
    expect(gallery.binding).toEqual({ssid: "DIRECT-ML-abcd", password: "", gateway: "192.168.43.1", phoneIpv4: "192.168.43.50"})
    expect(commands).toEqual([])
    expect(joins).toBe(0)
    await gallery.release()
    expect(commands).toEqual([])
    expect(disconnects).toBe(1)
  })

  test("a hotspot-off report does not end a Wi-Fi Direct link: starting the group stops the hotspot", async () => {
    wifiDirect = true
    const hold = await holdGlassesWifi({consumer: "ota"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    hotspotListeners.forEach((listener) => listener({state: "disabled"}))
    await settle()
    expect(events).toEqual([])
    await hold.release()
  })

  test("the radio is chosen again when the link comes back", async () => {
    wifiDirect = true
    const hold = await holdGlassesWifi({consumer: "ota"})
    wifiDirect = false
    setLink("disconnected")
    setLink("connected", true)
    await settle()
    expect(directJoins).toBe(1)
    expect(joins).toBe(1)
    expect(hold.binding.ssid).toBe("MentraLive_abc123")
    await hold.release()
  })
})

