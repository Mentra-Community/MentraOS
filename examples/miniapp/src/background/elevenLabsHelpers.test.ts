import {describe, expect, test} from "bun:test"

import {
  appendQueryParam,
  approxBase64ByteLength,
  buildWavHeader,
  ELEVENLABS_RECORDING_BLOB_KEY,
  parsePcmSampleRate,
  pcmDurationMs,
  resamplePcm16Le,
  WAV_HEADER_BYTES,
} from "./elevenLabsHelpers"

describe("elevenLabsHelpers", () => {
  test("appendQueryParam adds ? or & and preserves hash", () => {
    expect(appendQueryParam("http://host/signed-url", "agent_id", "a1")).toBe(
      "http://host/signed-url?agent_id=a1",
    )
    expect(appendQueryParam("http://host/signed-url?x=1", "agent_id", "a1")).toBe(
      "http://host/signed-url?x=1&agent_id=a1",
    )
    expect(appendQueryParam("http://host/signed-url#frag", "agent_id", "a b")).toBe(
      "http://host/signed-url?agent_id=a%20b#frag",
    )
  })

  test("approxBase64ByteLength accounts for padding", () => {
    expect(approxBase64ByteLength("AAAA")).toBe(3)
    expect(approxBase64ByteLength("AAA=")).toBe(2)
    expect(approxBase64ByteLength("AA==")).toBe(1)
  })

  test("parsePcmSampleRate reads pcm_N and rejects others", () => {
    expect(parsePcmSampleRate("pcm_16000")).toBe(16000)
    expect(parsePcmSampleRate("pcm_24000")).toBe(24000)
    expect(parsePcmSampleRate("ulaw_8000")).toBeNull()
    expect(parsePcmSampleRate("pcm_")).toBeNull()
  })

  test("resamplePcm16Le doubles sample count when rate doubles", () => {
    const input = new Uint8Array(4)
    const view = new DataView(input.buffer)
    view.setInt16(0, 1000, true)
    view.setInt16(2, -1000, true)
    const out = resamplePcm16Le(input, 16000, 32000)
    expect(out.byteLength).toBe(8)
    expect(resamplePcm16Le(input, 16000, 16000)).toBe(input)
  })

  test("buildWavHeader writes RIFF sizes for PCM data", () => {
    const dataBytes = 32000
    const h = buildWavHeader(16000, dataBytes)
    expect(h.byteLength).toBe(WAV_HEADER_BYTES)
    expect(String.fromCharCode(...h.slice(0, 4))).toBe("RIFF")
    expect(String.fromCharCode(...h.slice(8, 12))).toBe("WAVE")
    const view = new DataView(h.buffer)
    expect(view.getUint32(4, true)).toBe(36 + dataBytes)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(dataBytes)
  })

  test("pcmDurationMs and fixed blob key", () => {
    expect(pcmDurationMs(32000, 16000)).toBe(1000)
    expect(ELEVENLABS_RECORDING_BLOB_KEY).toBe("elevenlabs-conversation.wav")
  })
})
