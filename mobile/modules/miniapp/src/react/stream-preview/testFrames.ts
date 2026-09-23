/**
 * Build `MFPV` frames for tests. Lives beside the parser so the golden-bytes test and the parser
 * cannot drift apart silently. Not exported from the package entry.
 */

import {
  chromaDimensions,
  packedPayloadBytes,
  PIXEL_FORMAT_I420,
  PIXEL_FORMAT_NV12,
  PREVIEW_FRAME_HEADER_BYTES,
  PREVIEW_FRAME_MAGIC,
  PREVIEW_FRAME_VERSION,
  type PreviewPixelFormat,
} from "./protocol"

export interface BuildPreviewFrameOptions {
  width?: number
  height?: number
  pixelFormat?: PreviewPixelFormat
  sessionGen?: number
  frameSeq?: number
  rotationQuarters?: number
  /** Raw header codes so a test can send "unknown" (0) and check the fallback. */
  colorMatrixCode?: number
  colorRangeCode?: number
  flags?: number
  timestampNs?: bigint
  sentAtNs?: bigint
  /** Byte written into every sample of each plane, so plane views can be told apart. */
  fill?: {y?: number; u?: number; v?: number}
  /** Deliberate corruption, for the rejection tests. Every field overrides what would be written. */
  corrupt?: {
    magic?: readonly number[]
    version?: number
    headerLen?: number
    payloadLen?: number
    /** Payload bytes actually appended, independent of the declared `payloadLen`. */
    payloadBytes?: number
    pixelFormatCode?: number
  }
}

/** Build a wire-format frame. */
export function buildPreviewFrame(options: BuildPreviewFrameOptions = {}): ArrayBuffer {
  const width = options.width ?? 1280
  const height = options.height ?? 720
  const pixelFormat = options.pixelFormat ?? "i420"
  const corrupt = options.corrupt ?? {}
  const chroma = chromaDimensions(width, height)
  const declaredPayload = corrupt.payloadLen ?? packedPayloadBytes(width, height)
  const actualPayload = corrupt.payloadBytes ?? packedPayloadBytes(width, height)
  const buffer = new ArrayBuffer(PREVIEW_FRAME_HEADER_BYTES + actualPayload)
  const header = new DataView(buffer, 0, PREVIEW_FRAME_HEADER_BYTES)
  const magic = corrupt.magic ?? PREVIEW_FRAME_MAGIC
  for (let index = 0; index < 4; index += 1) header.setUint8(index, magic[index] ?? 0)
  header.setUint16(4, corrupt.version ?? PREVIEW_FRAME_VERSION, true)
  header.setUint16(6, corrupt.headerLen ?? PREVIEW_FRAME_HEADER_BYTES, true)
  header.setUint32(8, declaredPayload, true)
  header.setUint32(12, options.sessionGen ?? 1, true)
  header.setUint32(16, options.frameSeq ?? 1, true)
  header.setUint16(20, width, true)
  header.setUint16(22, height, true)
  header.setUint8(24, corrupt.pixelFormatCode ?? (pixelFormat === "nv12" ? PIXEL_FORMAT_NV12 : PIXEL_FORMAT_I420))
  header.setUint8(25, options.rotationQuarters ?? 0)
  header.setUint8(26, options.colorMatrixCode ?? 1)
  header.setUint8(27, options.colorRangeCode ?? 1)
  header.setUint16(28, options.flags ?? 0, true)
  header.setBigInt64(32, options.timestampNs ?? 0n, true)
  header.setBigInt64(40, options.sentAtNs ?? 0n, true)

  const payload = new Uint8Array(buffer, PREVIEW_FRAME_HEADER_BYTES)
  const luma = Math.min(width * height, payload.length)
  const chromaPlane = chroma.width * chroma.height
  payload.fill(options.fill?.y ?? 0x80, 0, luma)
  if (pixelFormat === "nv12") {
    for (let index = luma; index + 1 < payload.length; index += 2) {
      payload[index] = options.fill?.u ?? 0x40
      payload[index + 1] = options.fill?.v ?? 0xc0
    }
  } else {
    payload.fill(options.fill?.u ?? 0x40, luma, Math.min(luma + chromaPlane, payload.length))
    payload.fill(options.fill?.v ?? 0xc0, Math.min(luma + chromaPlane, payload.length))
  }
  return buffer
}
