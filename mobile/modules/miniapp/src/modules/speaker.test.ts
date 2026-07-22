/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {SpeakerModule, SpeakerStreamWriter, SPEAKER_WRITE_CHUNK_BYTES} from "./speaker"
import {base64ToBytes} from "./base64"

function mockSession(results: unknown[] | ((payload: Record<string, unknown>) => unknown)) {
  const requestCalls: Record<string, unknown>[] = []
  const requestOptions: unknown[] = []
  const resolveResult =
    typeof results === "function" ? results : () => (results.length > 1 ? results.shift() : results[0])
  const session = {
    sendOneShot: () => {
      throw new Error("stream requests should use sendRequest")
    },
    sendRequest: (payload: Record<string, unknown>, options?: unknown) => {
      requestCalls.push(payload)
      requestOptions.push(options)
      return Promise.resolve(resolveResult(payload))
    },
  } as unknown as MiniappSession

  return {session, requestCalls, requestOptions}
}

describe("SpeakerModule.speak", () => {
  test("uses one SPEAK request and forwards local routing and barge-in options", async () => {
    const {session, requestCalls, requestOptions} = mockSession([{completed: false}])
    const speaker = new SpeakerModule(session)

    const result = await speaker.speak("First sentence. Second sentence.", {
      forceLocal: true,
      stopOtherAudio: false,
    })

    expect(result).toEqual({completed: false})
    expect(requestCalls).toEqual([
      {
        type: MiniappRequestType.SPEAK,
        text: "First sentence. Second sentence.",
        voice_id: undefined,
        voice_settings: undefined,
        volume: undefined,
        stopOtherAudio: false,
        enableSanitization: true,
        forceLocal: true,
      },
    ])
    expect(requestOptions).toEqual([{timeoutMs: 0}])
  })

  test("sends an explicit sentence list through the normal SPEAK request", async () => {
    const {session, requestCalls} = mockSession([{completed: true}])
    const speaker = new SpeakerModule(session)

    await speaker.speak(["First sentence.", "Second sentence."], {forceLocal: true})

    expect(requestCalls[0]).toMatchObject({
      type: MiniappRequestType.SPEAK,
      text: ["First sentence.", "Second sentence."],
      forceLocal: true,
    })
  })

  test("forwards an explicit sanitization opt-out", async () => {
    const {session, requestCalls} = mockSession([{completed: true}])
    const speaker = new SpeakerModule(session)

    await speaker.speak("Read C++ exactly.", {enableSanitization: false})

    expect(requestCalls[0]).toMatchObject({
      type: MiniappRequestType.SPEAK,
      text: "Read C++ exactly.",
      enableSanitization: false,
    })
  })

  test("rejects an empty explicit sentence list", async () => {
    const {session, requestCalls} = mockSession([])
    const speaker = new SpeakerModule(session)

    await expect(speaker.speak([])).rejects.toMatchObject({code: "INTERNAL"})
    expect(requestCalls).toEqual([])
  })

  test("rejects empty or whitespace-only text", async () => {
    const {session, requestCalls} = mockSession([])
    const speaker = new SpeakerModule(session)

    await expect(speaker.speak("")).rejects.toMatchObject({code: "INTERNAL"})
    await expect(speaker.speak("   ")).rejects.toMatchObject({code: "INTERNAL"})
    expect(requestCalls).toEqual([])
  })
})

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

    const big = new Uint8Array(SPEAKER_WRITE_CHUNK_BYTES * 2 + 6)
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

  test("writeBase64 splits on base64 and 16-bit PCM boundaries", async () => {
    const {session, requestCalls} = mockSession([{bufferedMs: 10}])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    // Six raw bytes map to eight chars, preserving both framing boundaries.
    const chunkChars = Math.floor(SPEAKER_WRITE_CHUNK_BYTES / 6) * 8
    const b64 = "A".repeat(chunkChars + 8)
    await writer.writeBase64(b64)

    expect(requestCalls).toHaveLength(2)
    for (const call of requestCalls) {
      expect((call.base64 as string).length % 4).toBe(0)
      expect(base64ToBytes(call.base64 as string).length % 2).toBe(0)
    }
  })

  test("writeBase64 rejects a partial 16-bit PCM sample", async () => {
    const {session} = mockSession([])
    const writer = new SpeakerStreamWriter(session, "spk-1")

    await expect(writer.writeBase64("AAAA")).rejects.toThrow("complete 16-bit samples")
  })

  test("serializes overlapping writes so PCM stays ordered", async () => {
    const order: number[] = []
    let releaseFirst: (() => void) | undefined
    const session = {
      sendRequest: async (payload: Record<string, unknown>) => {
        const firstByte = base64ToBytes(payload.base64 as string)[0]
        order.push(firstByte)
        if (firstByte === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return {bufferedMs: 0}
      },
    } as unknown as MiniappSession
    const writer = new SpeakerStreamWriter(session, "spk-ordered")

    const first = writer.write(new Uint8Array([1, 0]))
    const second = writer.write(new Uint8Array([2, 0]))
    await Promise.resolve()

    expect(order).toEqual([1])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual([1, 2])
  })

  test("rejects empty and partial 16-bit PCM samples", async () => {
    const {session} = mockSession([{bufferedMs: 0}])
    const writer = new SpeakerStreamWriter(session, "spk-validation")

    expect(writer.write(new Uint8Array())).rejects.toThrow("cannot be empty")
    expect(writer.write(new Uint8Array([1]))).rejects.toThrow("complete 16-bit samples")
  })
})

describe("SpeakerModule.createStream validation", () => {
  test("rejects a volume outside the native range before opening", async () => {
    const {session, requestCalls} = mockSession([{streamId: "unused"}])
    const speaker = new SpeakerModule(session)

    expect(speaker.createStream({volume: 1.1})).rejects.toThrow("between 0 and 1")
    expect(requestCalls).toHaveLength(0)
  })
})
