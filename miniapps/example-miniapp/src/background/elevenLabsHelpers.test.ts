import {describe, expect, test} from "bun:test"

import {
  appendQueryParam,
  approxBase64ByteLength,
  parsePcmSampleRate,
  resamplePcm16Le,
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
})
