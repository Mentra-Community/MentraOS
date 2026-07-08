/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {SpeakerModule, SpeakerStreamWriter, SPEAKER_WRITE_CHUNK_BYTES} from "./speaker"
import {base64ToBytes} from "./base64"

function mockSession(results: unknown[] | ((payload: Record<string, unknown>) => unknown)) {
  const requestCalls: Record<string, unknown>[] = []
  const resolveResult =
    typeof results === "function" ? results : () => (results.length > 1 ? results.shift() : results[0])
  const session = {
    sendOneShot: () => {
      throw new Error("stream requests should use sendRequest")
    },
    sendRequest: (payload: Record<string, unknown>) => {
      requestCalls.push(payload)
      return Promise.resolve(resolveResult(payload))
    },
  } as unknown as MiniappSession

  return {session, requestCalls}
}

describe("SpeakerModule.createStream", () => {
  test("sends SPEAKER_STREAM_OPEN with defaulted options and returns a writer", async () => {
    const {session, requestCalls} = mockSession([{streamId: "spk-1"}])
    const speaker = new SpeakerModule(session)

    const writer = await speaker.createStream()

    expect(writer).toBeInstanceOf(SpeakerStreamWriter)
    expect(writer.streamId).toBe("spk-1")
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.SPEAKER_STREAM_OPEN,
        sampleRate: 16000,
        channels: 1,
        volume: undefined,
        stopOtherAudio: true,
      },
    ])
  })

  test("passes explicit options through", async () => {
    const {session, requestCalls} = mockSession([{streamId: "spk-2"}])
    const speaker = new SpeakerModule(session)

    await speaker.createStream({sampleRate: 48000, volume: 0.5, stopOtherAudio: false})

    expect(requestCalls[0]).toMatchObject({
      sampleRate: 48000,
      volume: 0.5,
      stopOtherAudio: false,
    })
  })
})

describe("SpeakerStreamWriter", () => {
  test("write() base64-encodes bytes and surfaces bufferedMs", async () => {
    const {session, requestCalls} = mockSession([{bufferedMs: 120}])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    const pcm = new Uint8Array([1, 2, 3, 4])
    const res = await writer.write(pcm)

    expect(res).toEqual({bufferedMs: 120})
    expect(requestCalls).toHaveLength(1)
    const call = requestCalls[0]
    expect(call.type).toBe(MiniappRequestType.SPEAKER_STREAM_WRITE)
    expect(call.streamId).toBe("spk-1")
    expect(base64ToBytes(call.base64 as string)).toEqual(pcm)
  })

  test("write() auto-splits large buffers into bridge-safe chunks", async () => {
    const {session, requestCalls} = mockSession([{bufferedMs: 0}])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    const big = new Uint8Array(SPEAKER_WRITE_CHUNK_BYTES * 2 + 5)
    await writer.write(big)

    expect(requestCalls).toHaveLength(3)
    const total = requestCalls.reduce((n, c) => n + base64ToBytes(c.base64 as string).length, 0)
    expect(total).toBe(big.length)
  })

  test("write() after close()/abort() throws", async () => {
    const {session} = mockSession([{bufferedMs: 0}])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    await writer.close()
    expect(writer.write(new Uint8Array(2))).rejects.toThrow("already closed")

    const {session: s2} = mockSession([{bufferedMs: 0}])
    const w2 = new SpeakerStreamWriter(s2, "spk-2")
    await w2.abort()
    expect(w2.write(new Uint8Array(2))).rejects.toThrow("already closed")
  })

  test("close() sends CLOSE with no timeout and returns durationMs", async () => {
    const {session, requestCalls} = mockSession([{durationMs: 5400}])
    let closeOpts: unknown
    const orig = session.sendRequest.bind(session)
    ;(session as unknown as {sendRequest: typeof orig}).sendRequest = (
      payload: Record<string, unknown>,
      opts?: unknown,
    ) => {
      closeOpts = opts
      return orig(payload)
    }
    const writer = new SpeakerStreamWriter(session, "spk-1")

    const res = await writer.close()

    expect(res).toEqual({durationMs: 5400})
    expect(requestCalls[0]).toEqual({type: MiniappRequestType.SPEAKER_STREAM_CLOSE, streamId: "spk-1"})
    expect(closeOpts).toEqual({timeoutMs: 0})
  })

  test("abort() is idempotent", async () => {
    const {session, requestCalls} = mockSession([undefined])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    await writer.abort()
    await writer.abort()

    expect(requestCalls).toHaveLength(1)
    expect(requestCalls[0]).toEqual({type: MiniappRequestType.SPEAKER_STREAM_ABORT, streamId: "spk-1"})
  })

  test("writeBase64 splits on 4-char base64 boundaries", async () => {
    const {session, requestCalls} = mockSession([{bufferedMs: 10}])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    // A base64 string bigger than one chunk (chunk is chunkBytes/3*4 chars).
    const chunkChars = Math.floor(SPEAKER_WRITE_CHUNK_BYTES / 3) * 4
    const b64 = "A".repeat(chunkChars + 8)
    await writer.writeBase64(b64)

    expect(requestCalls).toHaveLength(2)
    for (const call of requestCalls) {
      expect((call.base64 as string).length % 4).toBe(0)
    }
  })
})
