import {describe, expect, it} from "bun:test"

import {buildInfoChunk, buildWavHeader, pcmDurationMs, pcmPeakLevel, u16le, u32le, WAV_HEADER_BYTES} from "./wav"

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
  it("trailerBytes folds into RIFF size but not data size", () => {
    const dataBytes = 32000
    const trailer = 48
    const h = buildWavHeader(16000, dataBytes, 1, 16, trailer)
    expect(readU32(h, 4)).toBe(36 + dataBytes + trailer) // RIFF covers the trailer
    expect(readU32(h, 40)).toBe(dataBytes) // data chunk unchanged
  })
})

describe("buildInfoChunk", () => {
  it("no tags → empty", () => {
    expect(buildInfoChunk({}).length).toBe(0)
    expect(buildInfoChunk({title: "  "}).length).toBe(0)
  })
  it("builds a well-formed LIST/INFO chunk with the right tags", () => {
    const chunk = buildInfoChunk({title: "Hi", artist: "Mentra"})
    // "LIST" <u32 listSize> "INFO" then sub-chunks.
    expect(str(chunk, 0, 4)).toBe("LIST")
    expect(str(chunk, 8, 4)).toBe("INFO")
    const listSize = readU32(chunk, 4)
    // Outer chunk total = 8 (LIST + size) + listSize, and the array is exactly that.
    expect(chunk.length).toBe(8 + listSize)
    expect(chunk.length % 2).toBe(0) // even-aligned

    // First sub-chunk: INAM "Hi\0" — payload size includes the NUL (=3), padded to 4.
    expect(str(chunk, 12, 4)).toBe("INAM")
    expect(readU32(chunk, 16)).toBe(3) // "Hi" + NUL
    expect(str(chunk, 20, 2)).toBe("Hi")
    expect(chunk[22]).toBe(0) // NUL terminator
    expect(chunk[23]).toBe(0) // pad to even

    // Second sub-chunk starts at 24: IART "Mentra\0" — payload 7, padded to 8.
    expect(str(chunk, 24, 4)).toBe("IART")
    expect(readU32(chunk, 28)).toBe(7)
    expect(str(chunk, 32, 6)).toBe("Mentra")
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
