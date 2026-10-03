/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "../envelope"
import {MiniappRequestType, MiniappResponseType} from "../protocol"
import {MiniappSession} from "../session"
import type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "../transport/types"
import {PreviewError, type PreviewHandleStatus} from "./stream"

class FakeTransport implements Transport {
  sent: string[] = []
  private messageHandler: TransportMessageHandler | null = null

  async open(): Promise<void> {}
  send(raw: string): void {
    this.sent.push(raw)
  }
  onMessage(handler: TransportMessageHandler): void {
    this.messageHandler = handler
  }
  onDisconnect(_handler: TransportDisconnectHandler): void {}
  close(): void {}
  isOpen(): boolean {
    return true
  }
  deliver(payload: object, requestId?: string): void {
    this.messageHandler?.(serializeEnvelope({payload, ...(requestId ? {requestId} : {})} as never))
  }
  requests(): Array<{requestId?: string; payload: Record<string, unknown>}> {
    return this.sent.map((raw) => parseEnvelope(raw)!) as never
  }
  lastRequest(): {requestId?: string; payload: Record<string, unknown>} {
    return this.requests().at(-1)!
  }
}

async function connectedSession(): Promise<{session: MiniappSession; transport: FakeTransport}> {
  const transport = new FakeTransport()
  const session = new MiniappSession({transport, packageName: "com.test.preview"})
  const connected = session.connect()
  await Promise.resolve()
  transport.deliver({type: MiniappResponseType.CONNECT_ACK, userId: "u", packageName: "com.test.preview"})
  await connected
  return {session, transport}
}

function reply(transport: FakeTransport, data: unknown, ok = true, error?: object): void {
  const {requestId} = transport.lastRequest()
  transport.deliver({type: MiniappResponseType.REQUEST_RESULT, requestId, ok, ...(ok ? {data} : {error})}, requestId)
}

describe("session.stream.preview()", () => {
  test("sends miniapp_stream_preview_start for the call source and returns a held handle", async () => {
    const {session, transport} = await connectedSession()
    const pending = session.stream.preview()
    await Promise.resolve()
    expect(transport.lastRequest().payload).toEqual({type: MiniappRequestType.STREAM_PREVIEW_START, source: "call"})
    reply(transport, {handleId: "h1", previewTraceId: "t1", source: "call"})
    const handle = await pending
    expect(handle).toMatchObject({handleId: "h1", previewTraceId: "t1", source: "call", state: "held"})
    session.disconnect()
  })

  test("the glasses source rejects with unsupported without asking the host", async () => {
    const {session, transport} = await connectedSession()
    const before = transport.sent.length
    const error = await session.stream.preview({source: "glasses"}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PreviewError)
    expect((error as PreviewError).code).toBe("unsupported")
    expect(transport.sent.length).toBe(before)
    session.disconnect()
  })

  test("host refusals surface as typed PreviewErrors", async () => {
    const {session, transport} = await connectedSession()
    for (const code of ["not_meeting_owner", "preview_busy", "permission_denied", "source_ended"]) {
      const pending = session.stream.preview().catch((e: unknown) => e)
      await Promise.resolve()
      reply(transport, undefined, false, {code, message: `refused: ${code}`})
      const error = (await pending) as PreviewError
      expect(error).toBeInstanceOf(PreviewError)
      expect(error.code).toBe(code)
    }
    session.disconnect()
  })

  test("stop() sends miniapp_stream_preview_stop once and ends the handle", async () => {
    const {session, transport} = await connectedSession()
    const pending = session.stream.preview()
    await Promise.resolve()
    reply(transport, {handleId: "h2", previewTraceId: "t2", source: "call"})
    const handle = await pending
    const statuses: PreviewHandleStatus[] = []
    handle.onStatus((s) => statuses.push(s))

    const stopping = handle.stop()
    await Promise.resolve()
    expect(transport.lastRequest().payload).toEqual({type: MiniappRequestType.STREAM_PREVIEW_STOP, handleId: "h2"})
    reply(transport, null)
    await stopping
    const sentAfterFirstStop = transport.sent.length
    await handle.stop()
    expect(transport.sent.length).toBe(sentAfterFirstStop)
    expect(handle.state).toBe("ended")
    expect(statuses).toEqual([{state: "ended", reason: "stopped"}])
    session.disconnect()
  })

  test("a host ended push ends the handle exactly once and ignores unknown handles", async () => {
    const {session, transport} = await connectedSession()
    const pending = session.stream.preview()
    await Promise.resolve()
    reply(transport, {handleId: "h3", previewTraceId: "t3", source: "call"})
    const handle = await pending
    const statuses: PreviewHandleStatus[] = []
    handle.onStatus((s) => statuses.push(s))

    transport.deliver({type: MiniappResponseType.STREAM_PREVIEW_STATUS, handleId: "other", state: "ended"})
    expect(handle.state).toBe("held")
    transport.deliver({type: MiniappResponseType.STREAM_PREVIEW_STATUS, handleId: "h3", state: "held"})
    transport.deliver({
      type: MiniappResponseType.STREAM_PREVIEW_STATUS,
      handleId: "h3",
      state: "ended",
      reason: "source_ended",
    })
    transport.deliver({
      type: MiniappResponseType.STREAM_PREVIEW_STATUS,
      handleId: "h3",
      state: "ended",
      reason: "again",
    })
    expect(handle.state).toBe("ended")
    expect(statuses).toEqual([{state: "ended", reason: "source_ended"}])

    // An ended handle does not send a stop: the host already released the lease.
    const before = transport.sent.length
    await handle.stop()
    expect(transport.sent.length).toBe(before)
    session.disconnect()
  })
})
