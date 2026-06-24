import {describe, expect, it} from "bun:test"

import {buildWavHeader, pcmPeakLevel, sanitizeSegment, u16le, u32le} from "./blobWav"

const str = (h: Uint8Array, at: number, len: number) => String.fromCharCode(...Array.from(h.subarray(at, at + len)))
const readU32 = (h: Uint8Array, at: number) => (h[at] | (h[at + 1] << 8) | (h[at + 2] << 16) | (h[at + 3] << 24)) >>> 0 // unsigned
const readU16 = (h: Uint8Array, at: number) => h[at] | (h[at + 1] << 8)

describe("little-endian encoders", () => {
  it("u32le", () => {
    expect(Array.from(u32le(0))).toEqual([0, 0, 0, 0])
    expect(Array.from(u32le(1))).toEqual([1, 0, 0, 0])
    expect(Array.from(u32le(0x01020304))).toEqual([0x04, 0x03, 0x02, 0x01])
    expect(readU32(u32le(4_000_000_000), 0)).toBe(4_000_000_000) // > 2^31, unsigned
  })
  it("u16le", () => {
    expect(Array.from(u16le(0x0102))).toEqual([0x02, 0x01])
    expect(Array.from(u16le(16))).toEqual([16, 0])
  })
})

describe("buildWavHeader", () => {
  it("produces a canonical 44-byte PCM/16-bit/mono header", () => {
    const dataBytes = 32000 // 1s @ 16kHz mono 16-bit
    const h = buildWavHeader(16000, dataBytes)
    expect(h.length).toBe(44)
    expect(str(h, 0, 4)).toBe("RIFF")
    expect(readU32(h, 4)).toBe(36 + dataBytes) // RIFF chunk size
    expect(str(h, 8, 4)).toBe("WAVE")
    expect(str(h, 12, 4)).toBe("fmt ")
    expect(readU32(h, 16)).toBe(16) // subchunk1 size
    expect(readU16(h, 20)).toBe(1) // PCM
    expect(readU16(h, 22)).toBe(1) // mono
    expect(readU32(h, 24)).toBe(16000) // sample rate
    expect(readU32(h, 28)).toBe(16000 * 2) // byte rate = rate * blockAlign
    expect(readU16(h, 32)).toBe(2) // block align = channels * bits/8
    expect(readU16(h, 34)).toBe(16) // bits per sample
    expect(str(h, 36, 4)).toBe("data")
    expect(readU32(h, 40)).toBe(dataBytes) // data size
  })

  it("computes byteRate/blockAlign for other rates", () => {
    const h = buildWavHeader(48000, 0)
    expect(readU32(h, 24)).toBe(48000)
    expect(readU32(h, 28)).toBe(96000)
    expect(readU32(h, 4)).toBe(36) // empty data → 36
    expect(readU32(h, 40)).toBe(0)
  })
})

describe("sanitizeSegment", () => {
  it("keeps safe chars, replaces the rest", () => {
    expect(sanitizeSegment("com.mentra.recorder")).toBe("com.mentra.recorder")
    expect(sanitizeSegment("a/b\\c")).toBe("a_b_c")
    expect(sanitizeSegment("tok en:123")).toBe("tok_en_123")
  })
  it("never allows traversal / empty segments", () => {
    expect(sanitizeSegment("")).toBe("_")
    expect(sanitizeSegment(".")).toBe("_")
    expect(sanitizeSegment("..")).toBe("_")
    // Dots are legal in filenames; only the path separators are stripped, so the
    // result is a single safe filename with no traversal.
    expect(sanitizeSegment("../../etc/passwd")).toBe(".._.._etc_passwd")
    expect(sanitizeSegment("../../etc/passwd")).not.toContain("/")
  })
  it("bounds length", () => {
    expect(sanitizeSegment("x".repeat(500)).length).toBe(120)
  })
})

describe("pcmPeakLevel", () => {
  it("is 0 for silence", () => {
    expect(pcmPeakLevel(new Uint8Array(64))).toBe(0)
  })
  it("is ~1 for full-scale", () => {
    // -32768 (0x8000 LE) is full scale
    const buf = new Uint8Array([0x00, 0x80, 0x00, 0x80])
    expect(pcmPeakLevel(buf)).toBeCloseTo(1, 5)
  })
  it("scales with amplitude", () => {
    const half = new Uint8Array(u16le(16384)) // +16384 ≈ 0.5
    expect(pcmPeakLevel(half)).toBeCloseTo(0.5, 2)
  })
})
