/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {parseEnvelope, serializeEnvelope} from "../../envelope"
import {MiniappRequestType, MiniappResponseType} from "../../protocol"
import {MiniappSession} from "../../session"
import type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "../../transport/types"

class TestTransport implements Transport {
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

  async waitForRequest(expectedType?: string, timeoutMs = 1000): Promise<{requestId?: string; payload: Record<string, unknown>}> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      for (let j = 0; j < this.sent.length; j++) {
        const env = parseEnvelope(this.sent[j])
        const payload = (env?.payload as Record<string, unknown>) ?? {}
        if (!expectedType || payload.type === expectedType) {
          this.sent.splice(j, 1)
          return {requestId: env?.requestId, payload}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out waiting for request of type: ${expectedType}`)
  }
}

async function setupSession() {
  const transport = new TestTransport()
  const session = new MiniappSession({transport})
  const connectPromise = session.connect()
  transport.deliverFromPhone({
    type: MiniappResponseType.CONNECT_ACK,
    userId: "user-1",
    packageName: "com.test.voice",
    capabilities: null,
  })
  await connectPromise
  return {transport, session}
}

describe("Speaker Stream State & Lifecycle (Issue #3892)", () => {
  test("1. session.speaker.isPlaying transitions to true when createStream() resolves", async () => {
    const {transport, session} = await setupSession()

    expect(session.speaker.isPlaying).toBe(false)
    expect(session.speaker.state).toBe("idle")

    const streamPromise = session.speaker.createStream({sampleRate: 24000})

    const req = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    expect(req.payload.type).toBe(MiniappRequestType.SPEAKER_STREAM_OPEN)

    // Deliver host envelopes matching fixed host order:
    // First SPEAKER_STATE ("playing"), then REQUEST_RESULT
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "playing",
    })
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_test_1"},
      },
      req.requestId,
    )

    const stream = await streamPromise
    expect(stream.streamId).toBe("stream_test_1")
    expect(session.speaker.isPlaying).toBe(true)
    expect(session.speaker.state).toBe("playing")
  })

  test("1b. isPlaying is immediately true upon createStream() resolve even if SPEAKER_STATE envelope is delayed", async () => {
    const {transport, session} = await setupSession()

    expect(session.speaker.isPlaying).toBe(false)

    const streamPromise = session.speaker.createStream({sampleRate: 16000})

    const req = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)

    // Host sends loading first
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "loading",
    })

    // Simulate IPC race: REQUEST_RESULT arrives BEFORE SPEAKER_STATE ("playing")
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_race_test"},
      },
      req.requestId,
    )

    const stream = await streamPromise
    // SDK activeStreams tracking ensures isPlaying is true immediately
    expect(session.speaker.isPlaying).toBe(true)

    // When the delayed playing envelope finally lands, isPlaying stays true
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "playing",
    })
    expect(session.speaker.isPlaying).toBe(true)
  })

  test("2a. session.speaker.isPlaying returns false after stream.close() settles", async () => {
    const {transport, session} = await setupSession()

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_close_test"},
      },
      openReq.requestId,
    )
    const stream = await streamPromise
    expect(session.speaker.isPlaying).toBe(true)

    const closePromise = stream.close()
    const closeReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_CLOSE)
    expect(closeReq.payload.type).toBe(MiniappRequestType.SPEAKER_STREAM_CLOSE)

    // Host emits stopped, then REQUEST_RESULT
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
      durationMs: 500,
    })
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {durationMs: 500},
      },
      closeReq.requestId,
    )

    const closeResult = await closePromise
    expect(closeResult.durationMs).toBe(500)
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("2b. session.speaker.isPlaying returns false after stream.abort() settles", async () => {
    const {transport, session} = await setupSession()

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_abort_test"},
      },
      openReq.requestId,
    )
    const stream = await streamPromise
    expect(session.speaker.isPlaying).toBe(true)

    const abortPromise = stream.abort()
    const abortReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_ABORT)
    expect(abortReq.payload.type).toBe(MiniappRequestType.SPEAKER_STREAM_ABORT)

    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
    })
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
      },
      abortReq.requestId,
    )

    await abortPromise
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("3. Rapid creation of a subsequent stream does not leave isPlaying false due to stale predecessor completion", async () => {
    const {transport, session} = await setupSession()

    // 1. Open Stream 1
    const stream1Promise = session.speaker.createStream()
    const req1 = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_1"},
      },
      req1.requestId,
    )
    const stream1 = await stream1Promise
    expect(session.speaker.isPlaying).toBe(true)

    // 2. Rapidly open Stream 2 (e.g. conversational turn interruption)
    const stream2Promise = session.speaker.createStream()
    const req2 = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_2"},
      },
      req2.requestId,
    )
    const stream2 = await stream2Promise
    expect(session.speaker.isPlaying).toBe(true)

    // 3. Stale completion from Stream 1 abort arrives from host (e.g., native onEnded from predecessor)
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
      durationMs: 120,
    })

    // Stream 2 is still active: isPlaying must remain true!
    expect(session.speaker.isPlaying).toBe(true)

    // 4. Stream 2 finally closes
    const close2Promise = stream2.close()
    const close2Req = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_CLOSE)
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
      durationMs: 350,
    })
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {durationMs: 350},
      },
      close2Req.requestId,
    )
    await close2Promise

    // Now all streams have settled
    expect(session.speaker.isPlaying).toBe(false)
  })
})
