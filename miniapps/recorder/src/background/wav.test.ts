import {describe, expect, it} from "bun:test"

import {buildWavHeader, pcmDurationMs, pcmPeakLevel, u16le, u32le, WAV_HEADER_BYTES} from "./wav"

const str = (h: Uint8Array, at: number, len: number) => String.fromCharCode(...Array.from(h.subarray(at, at + len)))
const readU32 = (h: Uint8Array, at: number) => (h[at] | (h[at + 1] << 8) | (h[at + 2] << 16) | (h[at + 3] << 24)) >>> 0
const readU16 = (h: Uint8Array, at: number) => h[at] | (h[at + 1] << 8)

describe("little-endian encoders", () => {
  it("u32le / u16le", () => {
    expect(Array.from(u32le(0x01020304))).toEqual([0x04, 0x03, 0x02, 0x01])
    expect(readU32(u32le(4_000_000_000), 0)).toBe(4_000_000_000)
    expect(Array.from(u16le(0x0102))).toEqual([0x02, 0x01])
  })
})

describe("buildWavHeader", () => {
  it("produces a canonical 44-byte PCM/16-bit/mono header", () => {
    const dataBytes = 32000
    const h = buildWavHeader(16000, dataBytes)
    expect(h.length).toBe(WAV_HEADER_BYTES)
    expect(str(h, 0, 4)).toBe("RIFF")
    expect(readU32(h, 4)).toBe(36 + dataBytes)
    expect(str(h, 8, 4)).toBe("WAVE")
    expect(str(h, 12, 4)).toBe("fmt ")
    expect(readU32(h, 16)).toBe(16)
    expect(readU16(h, 20)).toBe(1)
    expect(readU16(h, 22)).toBe(1)
    expect(readU32(h, 24)).toBe(16000)
    expect(readU32(h, 28)).toBe(32000)
    expect(readU16(h, 32)).toBe(2)
    expect(readU16(h, 34)).toBe(16)
    expect(str(h, 36, 4)).toBe("data")
    expect(readU32(h, 40)).toBe(dataBytes)
  })
  it("empty data → 36 / 0", () => {
    const h = buildWavHeader(48000, 0)
    expect(readU32(h, 4)).toBe(36)
    expect(readU32(h, 40)).toBe(0)
    expect(readU32(h, 28)).toBe(96000)
  })
})

describe("pcmPeakLevel", () => {
  it("silence → 0, full-scale → ~1, half → ~0.5", () => {
    expect(pcmPeakLevel(new Uint8Array(64))).toBe(0)
    expect(pcmPeakLevel(new Uint8Array([0x00, 0x80]))).toBeCloseTo(1, 5)
    expect(pcmPeakLevel(new Uint8Array(u16le(16384)))).toBeCloseTo(0.5, 2)
  })
})

describe("pcmDurationMs", () => {
  it("1s of 16k mono 16-bit = 32000 bytes", () => {
    expect(pcmDurationMs(32000, 16000)).toBe(1000)
    expect(pcmDurationMs(16000, 16000)).toBe(500)
    expect(pcmDurationMs(0, 16000)).toBe(0)
    expect(pcmDurationMs(100, 0)).toBe(0)
  })
})
