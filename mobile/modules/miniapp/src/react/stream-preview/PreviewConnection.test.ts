/// <reference types="bun-types" />
import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {
  PreviewControlError,
  type PreviewControlChannel,
  type PreviewControlRequest,
  type PreviewHostEvent,
} from "./controlChannel"
import {PreviewConnection, type PreviewConnectionState, type PreviewSink} from "./PreviewConnection"
import type {PreviewTier} from "./tiers"
import {setPreviewTraceSinkForTests} from "./trace"
import type {PreviewTransport} from "./transport"

const SMALL: PreviewTier = {width: 320, height: 180, maxFps: 15}
const LARGE: PreviewTier = {width: 640, height: 360, maxFps: 15}
const TOKEN = "tok-secret-4f2a"

class FakeChannel implements PreviewControlChannel {
  requests: PreviewControlRequest[] = []
  leaseHeld = true
  docGen = 7
  protocolVersion = 1
  refuse: string | null = null
  staleNext = false
  /** Handshakes that race a newer document (the host's `ready` after `handshake_without_ready`). */
  supersedeHandshakes = 0
  private listeners = new Set<(event: PreviewHostEvent) => void>()

  async request(request: PreviewControlRequest): Promise<unknown> {
    this.requests.push(request)
    if (request.cmd === "handshake") {
      if (this.refuse) throw new PreviewControlError(this.refuse)
      if (request.docGen && request.docGen !== this.docGen) return {stale: true}
      if (this.supersedeHandshakes > 0) {
        this.supersedeHandshakes -= 1
        this.docGen += 1
        return {stale: true}
      }
      if (!this.leaseHeld) return {t: "waiting_for_lease", docGen: this.docGen}
      return {
        t: "config",
        protocolVersion: this.protocolVersion,
        transport: "webmessage",
        token: TOKEN,
        docGen: this.docGen,
      }
    }
    if (this.staleNext) {
      this.staleNext = false
      return {stale: true}
    }
    return {applied: true}
  }

  onEvent(cb: (event: PreviewHostEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  push(event: PreviewHostEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  cmds(): string[] {
    return this.requests.map((r) => (r.cmd === "handshake" ? "handshake" : `${r.cmd}:${r.mountEpoch}`))
  }
}

class FakeTransport implements PreviewTransport {
  connected = false
  closed = false
  sent: string[] = []
  failConnect: string | null = null
  private errorCb: ((reason: string) => void) | null = null
  async connect(): Promise<void> {
    if (this.failConnect) throw Object.assign(new Error(this.failConnect), {reason: this.failConnect})
    this.connected = true
  }
  onBinary(): void {}
  onError(cb: (reason: string) => void): void {
    this.errorCb = cb
  }
  sendText(json: string): void {
    this.sent.push(json)
  }
  close(): void {
    this.closed = true
  }
  fail(reason: string): void {
    this.errorCb?.(reason)
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(options: {channel?: FakeChannel; visible?: boolean} = {}) {
  const channel = options.channel ?? new FakeChannel()
  const transports: FakeTransport[] = []
  const handlers = new Map<string, () => void>()
  let visible = options.visible ?? true
  let clock = 0
  const connection = new PreviewConnection({
    channel,
    createTransport: () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return transport
    },
    now: () => clock,
    listen: (_target, type, handler) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    isDocumentVisible: () => visible,
  })
  const states: PreviewConnectionState[] = []
  const errors: string[] = []
  const sinkFor = (mountEpoch: number): PreviewSink => ({
    mountEpoch,
    draw: () => 1,
    onState: (state) => states.push(state),
    onStatus: () => {},
    onError: (code) => errors.push(code),
  })
  return {
    channel,
    connection,
    transports,
    states,
    errors,
    sinkFor,
    fire: (type: string) => handlers.get(type)?.(),
    setVisible: (value: boolean) => {
      visible = value
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function show(connection: PreviewConnection, epoch: number, tier: PreviewTier | null = SMALL, running = true) {
  connection.update(epoch, {boxWidth: tier?.width ?? 0, boxHeight: tier?.height ?? 0, tier, running})
}

const traceLines: string[] = []
beforeEach(() => {
  traceLines.length = 0
  setPreviewTraceSinkForTests((line) => traceLines.push(line))
})
afterEach(() => setPreviewTraceSinkForTests())

describe("PreviewConnection", () => {
  test("mount handshakes once, configures the tier and starts; nothing leaks the token into logs", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "start:1"])
    expect(h.connection.currentState).toBe("open")
    expect(h.transports).toHaveLength(1)
    expect(h.channel.requests.slice(1).every((r) => r.token === TOKEN && r.docGen === 7)).toBe(true)
    expect(traceLines.some((line) => line.includes("phase=handshake_ok"))).toBe(true)
    expect(traceLines.join("\n")).not.toContain(TOKEN)
  })

  test("unmount then remount reuses the connection: stop, then start with the new epoch, no handshake", async () => {
    const h = setup()
    const first = h.connection.nextMountEpoch()
    const detach = h.connection.attach(h.sinkFor(first))
    show(h.connection, first)
    await settle()
    show(h.connection, first, SMALL, false)
    detach()
    await settle()
    const second = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(second))
    show(h.connection, second)
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "start:1", "stop:1", "start:2"])
    expect(h.transports).toHaveLength(1)
    expect(h.transports[0]!.closed).toBe(false)
    expect(h.connection.snapshot().handshakes).toBe(1)
  })

  test("an unmount and remount in the same tick hand production over without a stop", async () => {
    const h = setup()
    const first = h.connection.nextMountEpoch()
    show(h.connection, first)
    await settle()
    show(h.connection, first, SMALL, false)
    show(h.connection, h.connection.nextMountEpoch())
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "start:1", "start:2"])
  })

  test("a new document performs a new handshake", async () => {
    const channel = new FakeChannel()
    const first = setup({channel})
    show(first.connection, first.connection.nextMountEpoch())
    await settle()
    first.connection.dispose()
    channel.docGen = 8
    const second = setup({channel})
    show(second.connection, second.connection.nextMountEpoch())
    await settle()
    expect(channel.cmds()).toEqual(["handshake", "configure:1", "start:1", "handshake", "configure:1", "start:1"])
    expect(channel.requests.at(-1)!.docGen).toBe(8)
  })

  test("waiting_for_lease recovers on lease_available without polling", async () => {
    const h = setup()
    h.channel.leaseHeld = false
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.connection.currentState).toBe("waiting_for_lease")
    expect(h.channel.cmds()).toEqual(["handshake"])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.channel.cmds()).toEqual(["handshake"])

    h.channel.leaseHeld = true
    h.channel.push({t: "lease_available"})
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "handshake", "configure:1", "start:1"])
    expect(h.states).toContain("waiting_for_lease")
    expect(h.connection.currentState).toBe("open")
  })

  test("operations from a superseded mount epoch are ignored locally", async () => {
    const h = setup()
    const first = h.connection.nextMountEpoch()
    show(h.connection, first)
    const second = h.connection.nextMountEpoch()
    show(h.connection, second)
    await settle()
    show(h.connection, first, SMALL, false)
    await settle()
    expect(h.channel.cmds().filter((c) => c.startsWith("stop"))).toEqual([])
    expect(h.connection.snapshot().staleLocalOps).toBe(1)
  })

  test("a resize storm sends at most one configure per tier change", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    for (let width = 100; width <= 320; width += 20) {
      h.connection.update(epoch, {boxWidth: width, boxHeight: 150, tier: SMALL, running: true})
    }
    await settle()
    for (let width = 400; width <= 640; width += 20) {
      h.connection.update(epoch, {boxWidth: width, boxHeight: 300, tier: LARGE, running: true})
    }
    await settle()
    expect(h.channel.cmds().filter((c) => c.startsWith("configure"))).toHaveLength(2)
    expect(h.connection.snapshot().tierChanges).toBe(2)
  })

  test("a zero-size box never forces a handshake, and hides an open preview", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    show(h.connection, epoch, null)
    await settle()
    expect(h.channel.cmds()).toEqual([])
    show(h.connection, epoch)
    await settle()
    show(h.connection, epoch, null)
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "start:1", "stop:1"])
    expect(h.transports[0]!.closed).toBe(false)
  })

  test("an unknown protocol version reports unsupported and opens no transport", async () => {
    const h = setup()
    h.channel.protocolVersion = 2
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.connection.currentState).toBe("unsupported")
    expect(h.errors).toEqual(["unsupported"])
    expect(h.transports).toHaveLength(0)
  })

  test("a host refusal is surfaced with its code and retried within the reconnect budget", async () => {
    const h = setup()
    h.channel.refuse = "unsupported"
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    // The first attempt plus three budgeted reconnects, then it stops asking.
    expect(h.errors).toEqual(["unsupported", "unsupported", "unsupported", "unsupported"])
    expect(h.connection.currentState).toBe("error")
  })

  test("lease_ended closes the transport and waits for the next lease", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    h.channel.push({t: "lease_ended", reason: "source_ended"})
    expect(h.transports[0]!.closed).toBe(true)
    expect(h.connection.currentState).toBe("waiting_for_lease")
    expect(h.errors).toEqual(["source_ended"])
    h.channel.push({t: "lease_available"})
    await settle()
    expect(h.channel.cmds().slice(-3)).toEqual(["handshake", "configure:1", "start:1"])
    expect(h.transports).toHaveLength(2)
  })

  test("a host transport failure re-handshakes within a bounded budget", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    for (let i = 0; i < 5; i += 1) {
      h.channel.push({t: "error", code: "ack_timeout", docGen: 7})
      await settle()
    }
    expect(h.connection.snapshot().reconnects).toBe(3)
    expect(h.channel.cmds().filter((c) => c === "handshake")).toHaveLength(4)
    expect(traceLines.some((line) => line.includes("phase=reconnect_budget_exhausted"))).toBe(true)
  })

  test("errors for another document are ignored", async () => {
    const h = setup()
    show(h.connection, h.connection.nextMountEpoch())
    await settle()
    h.channel.push({t: "error", code: "transport_failed", docGen: 3})
    await settle()
    expect(h.connection.currentState).toBe("open")
  })

  test("a transport lost while hidden re-handshakes when the page is visible again", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    show(h.connection, epoch)
    await settle()
    h.setVisible(false)
    h.transports[0]!.fail("websocket_closed:1006")
    await settle()
    expect(h.connection.currentState).toBe("error")
    expect(h.channel.cmds().filter((c) => c === "handshake")).toHaveLength(1)
    h.setVisible(true)
    h.fire("visibilitychange")
    await settle()
    expect(h.connection.currentState).toBe("open")
    expect(h.channel.cmds().slice(-3)).toEqual(["handshake", "configure:1", "start:1"])
  })

  test("a stale reply means the credential is out of date and triggers one fresh handshake", async () => {
    const h = setup()
    const epoch = h.connection.nextMountEpoch()
    h.channel.staleNext = true
    show(h.connection, epoch)
    await settle()
    expect(h.connection.snapshot().staleReplies).toBe(1)
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "handshake", "configure:1", "start:1"])
  })

  test("a handshake superseded by a newer document re-handshakes instead of going unsupported", async () => {
    const h = setup()
    h.channel.supersedeHandshakes = 1
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.states).not.toContain("unsupported")
    expect(h.errors).toEqual([])
    expect(h.connection.currentState).toBe("open")
    expect(h.channel.cmds()).toEqual(["handshake", "handshake", "configure:1", "start:1"])
    expect(h.connection.snapshot().staleReplies).toBe(1)
    expect(h.connection.documentGeneration).toBe(8)
    expect(h.channel.requests.at(-1)!.docGen).toBe(8)
  })

  test("a lease after the host replaced the waiting document handshakes into the current one", async () => {
    const h = setup()
    h.channel.leaseHeld = false
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.connection.documentGeneration).toBe(7)

    h.channel.docGen = 8
    h.channel.leaseHeld = true
    h.channel.push({t: "lease_available"})
    await settle()
    expect(h.connection.currentState).toBe("open")
    expect(h.channel.requests.filter((r) => r.cmd === "handshake").map((r) => r.docGen)).toEqual([0, 7, 0])
    expect(h.connection.documentGeneration).toBe(8)
  })

  test("a host that keeps answering stale leaves the connection recoverable", async () => {
    const h = setup()
    h.channel.supersedeHandshakes = 10
    const epoch = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(epoch))
    show(h.connection, epoch)
    await settle()
    expect(h.connection.currentState).toBe("error")
    expect(h.channel.cmds()).toEqual(["handshake", "handshake", "handshake"])

    h.channel.supersedeHandshakes = 0
    h.fire("visibilitychange")
    await settle()
    expect(h.connection.currentState).toBe("open")
  })

  test("pack_failed halts this mount epoch until the next mount", async () => {
    const h = setup()
    const first = h.connection.nextMountEpoch()
    h.connection.attach(h.sinkFor(first))
    show(h.connection, first)
    await settle()
    h.channel.push({t: "error", code: "pack_failed", docGen: 7})
    show(h.connection, first)
    await settle()
    expect(h.channel.cmds()).toEqual(["handshake", "configure:1", "start:1"])
    const second = h.connection.nextMountEpoch()
    show(h.connection, second)
    await settle()
    expect(h.channel.cmds().at(-1)).toBe("start:2")
  })

  test("pagehide ends the document connection", async () => {
    const h = setup()
    show(h.connection, h.connection.nextMountEpoch())
    await settle()
    h.fire("pagehide")
    expect(h.transports[0]!.closed).toBe(true)
    expect(h.connection.currentState).toBe("closed")
  })
})
