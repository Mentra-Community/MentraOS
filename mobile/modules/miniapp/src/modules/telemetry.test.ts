import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "../envelope"
import {MiniappRequestType, MiniappResponseType} from "../protocol"
import {MiniappSession} from "../session"
import type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "../transport/types"

/** A host that answers CONNECT with `hostFeatures` (none for an older Mentra App) and records what it was sent. */
class FakeHost implements Transport {
  readonly sent: Array<Record<string, unknown>> = []
  private handler: TransportMessageHandler | null = null
  private open_ = false
  private ack: (() => void) | null = null

  constructor(private readonly hostFeatures: Record<string, boolean> | undefined, private readonly holdAck = false) {}

  async open() {
    this.open_ = true
  }
  send(raw: string) {
    const payload = parseEnvelope(raw)!.payload as Record<string, unknown>
    this.sent.push(payload)
    if (payload.type === MiniappRequestType.CONNECT) {
      this.ack = () =>
        this.handler?.(
          serializeEnvelope({
            payload: {type: MiniappResponseType.CONNECT_ACK, userId: "u", packageName: "com.example.call", capabilities: null, ...(this.hostFeatures ? {hostFeatures: this.hostFeatures} : {})},
          }),
        )
      if (!this.holdAck) queueMicrotask(() => this.ack?.())
    }
  }
  /** Answers the CONNECT it held, once the session has sent it. */
  async answer() {
    while (this.ack === null) await new Promise((resolve) => setTimeout(resolve, 1))
    this.ack()
  }
  onMessage(handler: TransportMessageHandler) {
    this.handler = handler
  }
  onDisconnect(_handler: TransportDisconnectHandler) {}
  close() {
    this.open_ = false
  }
  isOpen() {
    return this.open_
  }
  captures() {
    return this.sent.filter((payload) => payload.type === MiniappRequestType.TELEMETRY_CAPTURE)
  }
}

describe("session.telemetry.capture", () => {
  test("sends one fire-and-forget message to a Mentra App with the telemetry host feature", async () => {
    const host = new FakeHost({telemetry: true})
    const session = new MiniappSession({packageName: "com.example.call", transport: host})
    await session.connect()
    const result = session.telemetry.capture("call_ended", {platform: "teams", duration_s: 312, recorded: false})
    expect(result).toBeUndefined()
    expect(host.captures()).toEqual([
      {type: MiniappRequestType.TELEMETRY_CAPTURE, event: "call_ended", properties: {platform: "teams", duration_s: 312, recorded: false}},
    ])
    session.disconnect()
  })

  test("does nothing on a Mentra App without it, and checks nothing itself", async () => {
    const host = new FakeHost(undefined)
    const session = new MiniappSession({transport: host})
    await session.connect()
    session.telemetry.capture("call_started")
    session.telemetry.capture("Not A Valid Name!", {nested: {a: 1}} as never)
    expect(host.captures()).toEqual([])
    session.disconnect()
  })

  test("holds captures made before the handshake, then sends them only if the host takes them", async () => {
    const host = new FakeHost({telemetry: true}, true)
    const session = new MiniappSession({transport: host})
    const connecting = session.connect()
    session.telemetry.capture("call_started", {platform: "meet"})
    expect(host.captures()).toEqual([])
    await host.answer()
    await connecting
    expect(host.captures().map((payload) => payload.event)).toEqual(["call_started"])

    const old = new FakeHost(undefined, true)
    const other = new MiniappSession({transport: old})
    const waiting = other.connect()
    other.telemetry.capture("call_started")
    await old.answer()
    await waiting
    expect(old.captures()).toEqual([])
    session.disconnect()
    other.disconnect()
  })

  test("a held capture that cannot be sent never takes the others down", async () => {
    const host = new FakeHost({telemetry: true}, true)
    const session = new MiniappSession({transport: host})
    const connecting = session.connect()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    session.telemetry.capture("broken", cyclic as never)
    session.telemetry.capture("call_started", {platform: "zoom"})
    await host.answer()
    await connecting
    expect(host.captures().map((payload) => payload.event)).toEqual(["call_started"])
    session.disconnect()
  })

  test("never throws, whatever it is given", async () => {
    const host = new FakeHost({telemetry: true})
    const session = new MiniappSession({transport: host})
    await session.connect()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => session.telemetry.capture("call_ended", cyclic as never)).not.toThrow()
    expect(() => session.telemetry.capture(undefined as never)).not.toThrow()
    session.disconnect()
  })
})
