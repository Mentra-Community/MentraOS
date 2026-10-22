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
    const observedStates: string[] = []
    session.speaker.onStateChange((event) => observedStates.push(event.state))

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
    expect(observedStates).toEqual(["playing"])
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

  test("2a. session.speaker.isPlaying returns false after stream.close() settles and host emits stopped", async () => {
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

  test("2b. session.speaker.isPlaying returns false after stream.abort() settles and host emits stopped", async () => {
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

  test("3. Rapid creation of a subsequent stream: predecessor settlement does not clobber active stream state", async () => {
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

    // 3. Predecessor stream 1 settles (e.g. abort() resolves)
    const stream1Abort = stream1.abort()
    const abortReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_ABORT)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
      },
      abortReq.requestId,
    )
    await stream1Abort

    // Stream 1 settling must NOT clobber Stream 2: isPlaying remains true!
    expect(session.speaker.isPlaying).toBe(true)

    // 4. Stream 2 finally closes with host stopped event
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

  test("4. session.speaker.stop() sends STOP_AUDIO, clears active streams, and transitions isPlaying to false", async () => {
    const {transport, session} = await setupSession()
    const observedStates: string[] = []
    session.speaker.onStateChange((event) => observedStates.push(event.state))

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_stop_test"},
      },
      openReq.requestId,
    )
    await streamPromise
    expect(session.speaker.isPlaying).toBe(true)

    // Calling speaker.stop() sends STOP_AUDIO
    session.speaker.stop()
    const stopReq = await transport.waitForRequest(MiniappRequestType.STOP_AUDIO)
    expect(stopReq.payload.type).toBe(MiniappRequestType.STOP_AUDIO)

    // The host identifies the stream stopped by the request. The SDK already
    // emitted the local stopped transition, so this acknowledgement is ignored.
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
      streamId: "stream_stop_test",
    })
    expect(session.speaker.isPlaying).toBe(false)
    expect(observedStates).toEqual(["playing", "stopped"])
  })

  test("5. Un-scoped host terminal envelope does not clobber active stream, while speaker.stop() does", async () => {
    const {transport, session} = await setupSession()

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_unscoped_test"},
      },
      openReq.requestId,
    )
    await streamPromise
    expect(session.speaker.isPlaying).toBe(true)

    // A late terminal envelope from an earlier speak() or predecessor stream arrives
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
    })
    // Host-level envelopes are not stream-scoped; live stream writer keeps isPlaying true
    expect(session.speaker.isPlaying).toBe(true)

    // A late idle envelope also does not clobber active stream
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "idle",
    })
    expect(session.speaker.isPlaying).toBe(true)

    // Calling session.speaker.stop() explicitly clears active streams and transitions isPlaying to false
    session.speaker.stop()
    expect(session.speaker.isPlaying).toBe(false)
  })

  test("6. speaker state events stay aligned with active stream and matching stream termination", async () => {
    const {transport, session} = await setupSession()
    const observedStates: string[] = []
    session.speaker.onStateChange((event) => observedStates.push(event.state))

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_correlated_test"},
      },
      openReq.requestId,
    )
    await streamPromise

    // Unscoped terminal events can belong to earlier play()/speak() audio.
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
    })
    expect(session.speaker.state).toBe("playing")
    expect(session.speaker.isPlaying).toBe(true)
    expect(observedStates).not.toContain("stopped")

    // A terminal event tagged with this stream ends the active local stream.
    transport.deliverFromPhone({
      type: MiniappResponseType.SPEAKER_STATE,
      state: "stopped",
      streamId: "stream_correlated_test",
    })
    expect(session.speaker.state).toBe("stopped")
    expect(session.speaker.isPlaying).toBe(false)
    expect(observedStates).toEqual(["playing", "stopped"])
  })

  test("7. close() settles local state even when an older host sends an unscoped stopped event", async () => {
    const {transport, session} = await setupSession()
    const observedStates: string[] = []
    session.speaker.onStateChange((event) => observedStates.push(event.state))

    const streamPromise = session.speaker.createStream()
    const openReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_OPEN)
    transport.deliverFromPhone(
      {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data: {streamId: "stream_legacy_host_test"},
      },
      openReq.requestId,
    )
    const stream = await streamPromise

    const closePromise = stream.close()
    const closeReq = await transport.waitForRequest(MiniappRequestType.SPEAKER_STREAM_CLOSE)
    transport.deliverFromPhone({type: MiniappResponseType.SPEAKER_STATE, state: "stopped"})
    expect(session.speaker.state).toBe("playing")
    expect(session.speaker.isPlaying).toBe(true)

    transport.deliverFromPhone(
      {type: MiniappResponseType.REQUEST_RESULT, ok: true, data: {durationMs: 200}},
      closeReq.requestId,
    )
    await closePromise

    expect(session.speaker.state).toBe("stopped")
    expect(session.speaker.isPlaying).toBe(false)
    expect(observedStates).toEqual(["playing", "stopped"])
  })
})
