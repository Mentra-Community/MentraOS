/**
 * A photo taken from the glasses stream this phone is already decoding.
 *
 * While the glasses stream, their camera cannot also take a photo. A stream that passes through
 * this phone (a Teams call on either transport, a managed WebRTC stream) is decoded here, so its
 * next frame can be the photo: nothing is asked of the glasses and the stream does not pause.
 *
 * A stream the glasses publish straight to the internet (RTMP, SRT) never reaches the phone's
 * decoder. `isLive()` stays false for it, and the ordinary photo request gets the glasses'
 * CAMERA_BUSY.
 */

/** A decoded frame older than this is not from a stream a photo can come from. */
export const STREAM_FRAME_LIVE_WINDOW_MS = 1_000
const GRAB_TIMEOUT_MS = 1_500
const JPEG_QUALITY = 90

export interface StreamFrame {
  /** JPEG bytes. */
  base64: string
  width: number
  height: number
  bytes: number
}

export interface StreamFrameSource {
  /** This phone decoded a glasses frame within the last second. */
  isLive(): boolean
  /** The next decoded frame, or null when the stream stopped or the frame could not be read. */
  grab(): Promise<StreamFrame | null>
}

interface NativeStreamFrames {
  /** Milliseconds since the last decoded glasses frame, or -1. Missing on older native builds. */
  streamFrameAgeMs?: () => number
  grabStreamFrame?: (options: {quality: number; timeoutMs: number}) => Promise<StreamFrame>
}

let native: NativeStreamFrames | null | undefined

function loadNative(): NativeStreamFrames | null {
  if (native !== undefined) return native
  try {
    const {requireOptionalNativeModule} = require("expo-modules-core") as typeof import("expo-modules-core")
    native = requireOptionalNativeModule<NativeStreamFrames>("MentraGlassesMediaRelay") ?? null
  } catch {
    // A host without the media module, or a test runtime without Expo.
    native = null
  }
  return native
}

export const nativeStreamFrames: StreamFrameSource = {
  isLive() {
    const module = loadNative()
    if (!module?.streamFrameAgeMs || !module.grabStreamFrame) return false
    try {
      const ageMs = module.streamFrameAgeMs()
      return ageMs >= 0 && ageMs <= STREAM_FRAME_LIVE_WINDOW_MS
    } catch {
      return false
    }
  },
  async grab() {
    const module = loadNative()
    if (!module?.grabStreamFrame) return null
    try {
      const frame = await module.grabStreamFrame({quality: JPEG_QUALITY, timeoutMs: GRAB_TIMEOUT_MS})
      return frame?.base64 ? frame : null
    } catch (err) {
      console.warn(`[StreamFrameSource] no frame: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  },
}
