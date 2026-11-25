import {afterEach, beforeEach, describe, expect, jest, test} from "@jest/globals"

type Status = {state: "enabled" | "disabled"; ssid?: string; password?: string; localIp?: string}
type Answer = Status | Error | {code: string}
type Connection = {state: string; fullyBooted: boolean}

// The glasses and the phone's native join, faked. Jest hoists the mocks, so they share `mockState`.
const ENABLED: Status = {state: "enabled", ssid: "MentraLive_abc123", password: "pw", localIp: "192.168.43.1"}
const mockState = {
  // The glasses: each hotspot command takes the next scripted answer, else the requested state.
  commands: [] as boolean[],
  script: [] as Answer[],
  hotspotListeners: new Set<(event: {state: string}) => void>(),
  // The BLE link: connected and ready unless a test says otherwise.
  connection: {state: "connected", fullyBooted: true} as Connection,
  statusListeners: new Set<(changed: {connection?: Connection}) => void>(),
  // The phone's one native join.
  wifiDirect: false,
  directJoins: 0,
  joins: 0,
  joinAnswers: [] as Array<string | Error | Promise<string>>,
  disconnects: 0,
  lostListeners: new Set<() => void>(),
}

jest.mock("../_private/BluetoothSdkModule", () => ({
  __esModule: true,
  default: {
    setHotspotState: async (enabled: boolean) => {
      mockState.commands.push(enabled)
      const answer = mockState.script.shift()
      if (answer instanceof Error) throw answer
      if (answer && "code" in answer) throw Object.assign(new Error("session changed"), {code: answer.code})
      return answer ?? (enabled ? ENABLED : {state: "disabled"})
    },
    addListener: (_event: string, listener: (event: {state: string}) => void) => {
      mockState.hotspotListeners.add(listener)
      return {remove: () => mockState.hotspotListeners.delete(listener)}
    },
    onGlassesStatus: (listener: (changed: {connection?: Connection}) => void) => {
      mockState.statusListeners.add(listener)
      return () => mockState.statusListeners.delete(listener)
    },
    getGlassesStatus: async () => ({connection: mockState.connection}),
  },
}))

// Waits run at once: they are about order here, not time.
jest.mock("../glasses-wifi/native", () => ({
  joinHotspot: async () => {
    mockState.joins++
    const answer = mockState.joinAnswers.shift() ?? "192.168.43.20"
    if (answer instanceof Error) throw answer
    return answer
  },
  wifiDirectAvailable: () => mockState.wifiDirect,
  joinWifiDirect: async () => {
    mockState.directJoins++
    return {ssid: "DIRECT-ML-abcd", localAddress: "192.168.43.50", gateway: "192.168.43.1"}
  },
  leave: async () => {
    mockState.disconnects++
  },
  onLost: (listener: () => void) => {
    mockState.lostListeners.add(listener)
    return () => mockState.lostListeners.delete(listener)
  },
  delay: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
}))

const setLink = (state: string, fullyBooted = state === "connected") => {
  mockState.connection = {state, fullyBooted}
  mockState.statusListeners.forEach((listener) => listener({connection: mockState.connection}))
}
const hotspotReport = (state: string) => mockState.hotspotListeners.forEach((listener) => listener({state}))

let now = 1_000_000
const realNow = Date.now

const {GlassesWifiError, glassesWifiUp, holdGlassesWifi, onGlassesWifiUp, LATE_ENABLE_WINDOW_MS, RESTORE_DEADLINE_MS} =
  jest.requireActual<typeof import("../glasses-wifi/service")>("../glasses-wifi/service")

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  Object.assign(mockState, {
    script: [],
    joins: 0,
    directJoins: 0,
    wifiDirect: false,
    joinAnswers: [],
    disconnects: 0,
    connection: {state: "connected", fullyBooted: true},
  })
  mockState.commands.length = 0
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
    expect(mockState.commands).toEqual([true])
    expect(mockState.joins).toBe(1)

    await gallery.release()
    expect(mockState.commands).toEqual([true])
    await call.release()
    await call.release()
    expect(mockState.commands).toEqual([true, false])
    expect(mockState.disconnects).toBe(1)
  })

  test("a holder arriving while the link comes up waits for the same join", async () => {
    let finish!: (address: string) => void
    mockState.joinAnswers = [new Promise<string>((resolve) => (finish = resolve))]
    const first = holdGlassesWifi({consumer: "ota"})
    const second = holdGlassesWifi({consumer: "relay"})
    await settle()
    finish("192.168.43.30")
    const [a, b] = await Promise.all([first, second])
    expect(a.binding.phoneIpv4).toBe("192.168.43.30")
    expect(b.binding.phoneIpv4).toBe("192.168.43.30")
    expect(mockState.joins).toBe(1)
    await a.release()
    await b.release()
  })

  test("a hold that fails gives the link back", async () => {
    mockState.joinAnswers = [Object.assign(new Error("denied"), {code: "SOFTAP_PERMISSION_DENIED"})]
    const error = await holdGlassesWifi({consumer: "gallery"}).catch((e) => e)
    expect(error).toBeInstanceOf(GlassesWifiError)
    expect(error.stage).toBe("join")
    expect(error.code).toBe("SOFTAP_PERMISSION_DENIED")
    await settle()
    expect(mockState.commands).toEqual([true, false])
  })

  test("a glasses hotspot that will not start fails at the enable stage", async () => {
    mockState.script = [{state: "disabled"}, {state: "disabled"}, {state: "disabled"}]
    const error = await holdGlassesWifi({consumer: "gallery"}).catch((e) => e)
    expect(error).toBeInstanceOf(GlassesWifiError)
    expect(error.stage).toBe("enable")
    expect(mockState.joins).toBe(0)
  })
})

describe("bringing the link up", () => {
  test("an unanswered enable is asked again, never turned off", async () => {
    mockState.script = [new Error("Request timed out waiting for glasses response.")]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(mockState.commands).toEqual([true, true])
    await hold.release()
  })

  test("an enable answered 'disabled' is turned off and started once more", async () => {
    mockState.script = [{state: "disabled"}]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(mockState.commands).toEqual([true, false, true])
    await hold.release()
  })

  test("a command a restarting ASG dropped is re-sent once", async () => {
    mockState.script = [{code: "wifi_session_restarted"}]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(mockState.commands).toEqual([true, true])
    await hold.release()
  })

  test("an Unavailable join cycles the glasses hotspot and mockState.joins again", async () => {
    mockState.joinAnswers = [Object.assign(new Error("SSID not in scan"), {code: "SOFTAP_UNAVAILABLE"})]
    const hold = await holdGlassesWifi({consumer: "call"})
    expect(mockState.commands).toEqual([true, false, true])
    expect(mockState.joins).toBe(2)
    await hold.release()
  })

  test("other join failures are not retried", async () => {
    mockState.joinAnswers = [new Error("VPN")]
    await expect(holdGlassesWifi({consumer: "call"})).rejects.toThrow("VPN")
    expect(mockState.joins).toBe(1)
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
    await settle()
    expect(mockState.commands.at(-1)).toBe(false)
  })
})

describe("cancelling a hold", () => {
  test("a hold cancelled before the join settles at once and never starts the join", async () => {
    let answer!: (status: Status) => void
    mockState.script = [new Promise<Status>((resolve) => (answer = resolve)) as unknown as Status]
    const controller = new AbortController()
    const holding = holdGlassesWifi({consumer: "relay", signal: controller.signal})
    await settle()
    controller.abort()
    await expect(holding).rejects.toThrow("cancelled")
    answer(ENABLED)
    await settle()
    expect(mockState.joins).toBe(0)
    expect(mockState.commands.at(-1)).toBe(false)
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
    expect(mockState.joins).toBe(0)
    expect(mockState.commands).toEqual([true, false])
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
  test("whoever listens hears the link go up, down when lost, up when restored, and down when released", async () => {
    const heard: boolean[] = []
    const stop = onGlassesWifiUp((up) => heard.push(up))
    const hold = await holdGlassesWifi({consumer: "app fast link"})
    expect(glassesWifiUp()).toBe(true)
    setLink("disconnected")
    setLink("connected", true)
    await settle()
    await hold.release()
    stop()
    expect(heard).toEqual([true, false, true, false])
    expect(glassesWifiUp()).toBe(false)
  })

  test("glasses that restart are asked again once ready, and holders hear lost then restored", async () => {
    const hold = await holdGlassesWifi({consumer: "ota"})
    const events: string[] = []
    hold.onChange((event) =>
      events.push(event.type === "restored" ? `restored ${event.binding.phoneIpv4}` : event.type),
    )
    mockState.joinAnswers = ["192.168.43.40"]

    setLink("disconnected")
    expect(events).toEqual(["lost"])
    setLink("connected", false)
    await settle()
    expect(mockState.commands).toEqual([true])
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
    mockState.lostListeners.forEach((listener) => listener())
    await settle()
    expect(events).toEqual(["lost", "restored"])
    await ready
    expect(mockState.joins).toBe(2)
    await hold.release()
  })

  test("glasses that turn their hotspot off are a loss", async () => {
    const hold = await holdGlassesWifi({consumer: "call"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    hotspotReport("disabled")
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
    expect(mockState.joins).toBe(1)
  })
})

describe("a late hotspot", () => {
  test("an enabled report soon after the last release is turned off; later ones are left alone", async () => {
    const hold = await holdGlassesWifi({consumer: "gallery"})
    hotspotReport("enabled")
    expect(mockState.commands).toEqual([true])
    await hold.release()
    mockState.commands.length = 0
    hotspotReport("enabled")
    await settle()
    expect(mockState.commands).toEqual([false])
    now += LATE_ENABLE_WINDOW_MS
    hotspotReport("enabled")
    await settle()
    expect(mockState.commands).toEqual([false])
  })
})

describe("the Wi-Fi Direct link", () => {
  test("glasses and a phone that can hold a group get it instead of the hotspot, and its release sends no hotspot command", async () => {
    mockState.wifiDirect = true
    const gallery = await holdGlassesWifi({consumer: "gallery"})
    expect(gallery.binding).toEqual({ssid: "DIRECT-ML-abcd", password: "", gateway: "192.168.43.1", phoneIpv4: "192.168.43.50"})
    expect(mockState.commands).toEqual([])
    expect(mockState.joins).toBe(0)
    await gallery.release()
    expect(mockState.commands).toEqual([])
    expect(mockState.disconnects).toBe(1)
  })

  test("a hotspot-off report does not end a Wi-Fi Direct link: starting the group stops the hotspot", async () => {
    mockState.wifiDirect = true
    const hold = await holdGlassesWifi({consumer: "ota"})
    const events: string[] = []
    hold.onChange((event) => events.push(event.type))
    hotspotReport("disabled")
    await settle()
    expect(events).toEqual([])
    await hold.release()
  })

  test("the radio is chosen again when the link comes back", async () => {
    mockState.wifiDirect = true
    const hold = await holdGlassesWifi({consumer: "ota"})
    mockState.wifiDirect = false
    setLink("disconnected")
    setLink("connected", true)
    await settle()
    expect(mockState.directJoins).toBe(1)
    expect(mockState.joins).toBe(1)
    expect(hold.binding.ssid).toBe("MentraLive_abc123")
    await hold.release()
  })
})

