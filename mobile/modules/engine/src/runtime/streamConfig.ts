import type {StreamAudioConfig, StreamVideoConfig} from "./config"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

export const normalizeStreamVideoConfig = (value: unknown): StreamVideoConfig | undefined => {
  if (!isRecord(value)) return undefined
  const config: StreamVideoConfig = {}
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  const bitrate = finiteNumber(value.bitrate)
  const frameRate = finiteNumber(value.frameRate)
  const fps = frameRate ?? finiteNumber(value.fps)
  if (width !== undefined) config.width = width
  if (height !== undefined) config.height = height
  if (bitrate !== undefined) config.bitrate = bitrate
  if (fps !== undefined) config.fps = fps
  return Object.keys(config).length > 0 ? config : undefined
}

export const normalizeStreamAudioConfig = (value: unknown): StreamAudioConfig | undefined => {
  if (!isRecord(value)) return undefined
  const config: StreamAudioConfig = {}
  const bitrate = finiteNumber(value.bitrate)
  const sampleRate = finiteNumber(value.sampleRate)
  if (bitrate !== undefined) config.bitrate = bitrate
  if (sampleRate !== undefined) config.sampleRate = sampleRate
  if (typeof value.echoCancellation === "boolean") config.echoCancellation = value.echoCancellation
  if (typeof value.noiseSuppression === "boolean") config.noiseSuppression = value.noiseSuppression
  return Object.keys(config).length > 0 ? config : undefined
}

/** Absent or non-boolean values keep the caller-supplied fallback (default true). */
export const normalizeCaptureAudio = (value: unknown, fallback = true): boolean =>
  typeof value === "boolean" ? value : fallback

/**
 * Glasses capture is locked to the ACS source for the WHIP session.
 * Phone/bluetooth never encode the glasses mic, even if a miniapp asks for it.
 */
export const resolveCaptureAudio = (
  payload: unknown,
  source: "glasses" | "phone",
): boolean => source === "glasses" && normalizeCaptureAudio(payload, true)
