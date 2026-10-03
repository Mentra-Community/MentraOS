/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {packedPayloadBytes, parsePreviewFrame, PREVIEW_FRAME_HEADER_BYTES, type PreviewParseError} from "./protocol"
import {buildPreviewFrame} from "./testFrames"

/**
 * The header is a contract with native code that is written twice, in two languages, by two
 * people. Asserting the parsed object only proves this file agrees with itself, so the layout is
 * pinned byte by byte: if an offset moves, this is the test that says which one.
 */
const GOLDEN_HEADER = [
  // magic "MFPV"
  0x4d, 0x46, 0x50, 0x56,
  // version 1
  0x01, 0x00,
  // headerLen 64
  0x40, 0x00,
  // payloadLen 1382400 (1280x720 packed 4:2:0)
  0x00, 0x18, 0x15, 0x00,
  // sessionGen 7
  0x07, 0x00, 0x00, 0x00,
  // frameSeq 42
  0x2a, 0x00, 0x00, 0x00,
  // width 1280
  0x00, 0x05,
  // height 720
  0xd0, 0x02,
  // pixelFormat I420, rotation 1 quarter turn, BT.709, full range
  0x01, 0x01, 0x02, 0x02,
  // flags: sender colour fallback
  0x01, 0x00,
  // reserved
  0x00, 0x00,
  // timestampNs 123456789
  0x15, 0xcd, 0x5b, 0x07, 0x00, 0x00, 0x00, 0x00,
  // sentAtNs 987654321
  0xb1, 0x68, 0xde, 0x3a, 0x00, 0x00, 0x00, 0x00,
  // reserved
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]

function reasonOf(buffer: ArrayBuffer): string {
  const result = parsePreviewFrame(buffer)
  expect(result.ok).toBe(false)
  return (result as PreviewParseError).reason
}

describe("preview frame header", () => {
  test("writes the documented bytes at the documented offsets", () => {
    const buffer = buildPreviewFrame({
      width: 1280,
      height: 720,
      pixelFormat: "i420",
      sessionGen: 7,
      frameSeq: 42,
      rotationQuarters: 1,
      colorMatrixCode: 2,
      colorRangeCode: 2,
      flags: 1,
      timestampNs: 123456789n,
      sentAtNs: 987654321n,
    })
    expect(Array.from(new Uint8Array(buffer, 0, PREVIEW_FRAME_HEADER_BYTES))).toEqual(GOLDEN_HEADER)
    expect(buffer.byteLength).toBe(PREVIEW_FRAME_HEADER_BYTES + 1382400)
  })

  test("round trips those bytes back into a frame", () => {
    const buffer = buildPreviewFrame({
      sessionGen: 7,
      frameSeq: 42,
      rotationQuarters: 1,
      colorMatrixCode: 2,
      colorRangeCode: 2,
      flags: 1,
      timestampNs: 123456789n,
      sentAtNs: 987654321n,
    })
    const frame = parsePreviewFrame(buffer)
    expect(frame.ok).toBe(true)
    if (!frame.ok) return
    expect(frame).toMatchObject({
      sessionGen: 7,
      frameSeq: 42,
      width: 1280,
      height: 720,
      pixelFormat: "i420",
      rotationQuarters: 1,
      colorMatrix: "bt709",
      colorRange: "full",
      colorMatrixAssumed: false,
      colorRangeAssumed: false,
      senderColorFallback: true,
      payloadLen: 1382400,
    })
    expect(frame.timestampNs).toBe(123456789n)
    expect(frame.sentAtNs).toBe(987654321n)
  })
})

describe("plane views", () => {
  test("I420 planes are subviews of the caller's buffer, not copies", () => {
    const buffer = buildPreviewFrame({width: 4, height: 2, fill: {y: 0x10, u: 0x20, v: 0x30}})
    const frame = parsePreviewFrame(buffer)
    expect(frame.ok).toBe(true)
    if (!frame.ok || frame.pixelFormat !== "i420") throw new Error("expected an I420 frame")
    expect(frame.y.buffer).toBe(buffer)
    expect(frame.u.buffer).toBe(buffer)
    expect(frame.v.buffer).toBe(buffer)
    expect(frame.y.byteOffset).toBe(PREVIEW_FRAME_HEADER_BYTES)
    expect(frame.u.byteOffset).toBe(PREVIEW_FRAME_HEADER_BYTES + 8)
    expect(frame.v.byteOffset).toBe(PREVIEW_FRAME_HEADER_BYTES + 10)
    expect([frame.y.length, frame.u.length, frame.v.length]).toEqual([8, 2, 2])
    expect([frame.y[0], frame.u[0], frame.v[0]]).toEqual([0x10, 0x20, 0x30])
    // A view, so a write through the buffer is visible through the plane.
    new Uint8Array(buffer)[PREVIEW_FRAME_HEADER_BYTES] = 0x99
    expect(frame.y[0]).toBe(0x99)
  })

  test("NV12 exposes one interleaved chroma plane with a doubled stride", () => {
    const buffer = buildPreviewFrame({width: 4, height: 2, pixelFormat: "nv12", fill: {u: 0x20, v: 0x30}})
    const frame = parsePreviewFrame(buffer)
    expect(frame.ok).toBe(true)
    if (!frame.ok || frame.pixelFormat !== "nv12") throw new Error("expected an NV12 frame")
    expect(frame.uv.buffer).toBe(buffer)
    expect(frame.uv.length).toBe(4)
    expect(frame.chromaStride).toBe(4)
    expect(Array.from(frame.uv)).toEqual([0x20, 0x30, 0x20, 0x30])
  })

  test("odd sizes round the chroma plane up", () => {
    expect(packedPayloadBytes(3, 3)).toBe(9 + 2 * 4)
    const frame = parsePreviewFrame(buildPreviewFrame({width: 3, height: 3}))
    expect(frame.ok).toBe(true)
    if (!frame.ok || frame.pixelFormat !== "i420") throw new Error("expected an I420 frame")
    expect([frame.chromaWidth, frame.chromaHeight, frame.chromaStride]).toEqual([2, 2, 2])
  })
})

describe("colour metadata fallbacks", () => {
  test("unknown matrix and range fall back to BT.601 limited and say so", () => {
    const frame = parsePreviewFrame(buildPreviewFrame({colorMatrixCode: 0, colorRangeCode: 0}))
    expect(frame.ok).toBe(true)
    if (!frame.ok) return
    expect(frame).toMatchObject({
      colorMatrix: "bt601",
      colorRange: "limited",
      colorMatrixAssumed: true,
      colorRangeAssumed: true,
      senderColorFallback: false,
    })
  })
})

describe("rejections", () => {
  test("a buffer shorter than the header", () => {
    expect(reasonOf(new ArrayBuffer(PREVIEW_FRAME_HEADER_BYTES - 1))).toBe("short-buffer")
  })

  test("bad magic", () => {
    expect(reasonOf(buildPreviewFrame({corrupt: {magic: [0x4d, 0x46, 0x50, 0x00]}}))).toBe("bad-magic")
  })

  test("an unsupported version", () => {
    expect(reasonOf(buildPreviewFrame({corrupt: {version: 2}}))).toBe("unsupported-version")
  })

  test("a header length other than 64", () => {
    expect(reasonOf(buildPreviewFrame({corrupt: {headerLen: 48}}))).toBe("bad-header-length")
  })

  test("zero or oversized dimensions", () => {
    expect(reasonOf(buildPreviewFrame({width: 0, height: 720}))).toBe("bad-dimensions")
    expect(reasonOf(buildPreviewFrame({width: 16, height: 0}))).toBe("bad-dimensions")
    expect(reasonOf(buildPreviewFrame({width: 4097, height: 16}))).toBe("bad-dimensions")
  })

  test("an unknown pixel format", () => {
    expect(reasonOf(buildPreviewFrame({width: 16, height: 16, corrupt: {pixelFormatCode: 3}}))).toBe(
      "unknown-pixel-format",
    )
  })

  test("a payload length that is not the packed size", () => {
    expect(reasonOf(buildPreviewFrame({width: 16, height: 16, corrupt: {payloadLen: 100}}))).toBe(
      "payload-size-mismatch",
    )
  })

  test("a payload shorter than the header declares", () => {
    const short = buildPreviewFrame({width: 16, height: 16, corrupt: {payloadBytes: packedPayloadBytes(16, 16) - 1}})
    expect(reasonOf(short)).toBe("truncated-payload")
  })

  test("reports the first failure in the documented order", () => {
    // Bad magic and a bad version at once: magic is checked first, so that is what is reported.
    expect(reasonOf(buildPreviewFrame({corrupt: {magic: [0, 0, 0, 0], version: 9}}))).toBe("bad-magic")
  })

  test("never throws on arbitrary bytes", () => {
    const random = new Uint8Array(PREVIEW_FRAME_HEADER_BYTES + 16)
    random.fill(0xab)
    expect(() => parsePreviewFrame(random.buffer)).not.toThrow()
    expect(parsePreviewFrame(random.buffer).ok).toBe(false)
  })
})
