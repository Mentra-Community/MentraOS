/// <reference types="bun-types" />
/**
 * Shared test harness for navigation suites.
 *
 * Every test under src/test/navigation/* uses this. The split is by method
 * — one folder per `session.navigation.*` surface, each with its own
 * fixtures/ dir of {case}.input.json / {case}.expected.json / {case}.response.json
 * files.
 */
import {expect} from "bun:test"

import {
  MiniappResponseType,
  MiniappSession,
  parseEnvelope,
  serializeEnvelope,
} from "@mentra/miniapp"
import type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "@mentra/miniapp"

export class FakeTransport implements Transport {
  sent: string[] = []
  private messageHandler: TransportMessageHandler | null = null
  private disconnectHandler: TransportDisconnectHandler | null = null
  private open_ = false

  async open(): Promise<void> {
    this.open_ = true
  }
  send(raw: string): void {
    this.sent.push(raw)
  }
  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }
  onDisconnect(handler: TransportDisconnectHandler): void {
    this.disconnectHandler = handler
  }
  close(): void {
    this.open_ = false
  }
  isOpen(): boolean {
    return this.open_
  }

  deliverFromPhone(payload: object, requestId?: string): void {
    const env = {payload, ...(requestId ? {requestId} : {})}
    this.messageHandler?.(serializeEnvelope(env as never))
  }
}

export async function connectedSession(opts: {location: boolean}): Promise<{session: MiniappSession; transport: FakeTransport}> {
  const transport = new FakeTransport()
  const session = new MiniappSession({transport, packageName: "com.mentra.navigation"})
  const connectPromise = session.connect()
  transport.deliverFromPhone({
    type: MiniappResponseType.CONNECT_ACK,
    userId: "u",
    packageName: "com.mentra.navigation",
    capabilities: null,
    permissions: {
      location: opts.location,
      microphone: false,
      camera: false,
      notifications: false,
      calendar: false,
    },
  })
  await connectPromise
  return {session, transport}
}

/** Latest payload the SDK pushed to the transport. */
export function lastOutbound(transport: FakeTransport): Record<string, unknown> {
  const env = parseEnvelope(transport.sent[transport.sent.length - 1]!)
  expect(env).not.toBeNull()
  return env!.payload as Record<string, unknown>
}

/** Envelope (payload + requestId) of the latest outbound message. */
export function lastEnvelope(transport: FakeTransport): {payload: Record<string, unknown>; requestId?: string} {
  const env = parseEnvelope(transport.sent[transport.sent.length - 1]!)
  expect(env).not.toBeNull()
  return {payload: env!.payload as Record<string, unknown>, requestId: env!.requestId}
}

/** Deliver a REQUEST_RESULT keyed to the most recent outbound request. */
export function ackLatest(transport: FakeTransport, data: unknown, ok = true): void {
  const env = parseEnvelope(transport.sent[transport.sent.length - 1]!)
  transport.deliverFromPhone(
    {type: MiniappResponseType.REQUEST_RESULT, ok, data},
    env!.requestId!,
  )
}

/** Deliver an EVENT push on the given stream type. */
export function pushEvent(transport: FakeTransport, streamType: string, data: unknown): void {
  transport.deliverFromPhone({
    type: MiniappResponseType.EVENT,
    streamType,
    data,
  })
}
