export type SourceReason =
  | "explicit"
  | "current-mic"
  | "ranking"
  | "fallback-glasses-connected"
  | "fallback-no-glasses"

export type AcsAudioSource = "glasses" | "phone"

/**
 * Single switch for Mentra Call ACS uplink.
 * `"phone"` = AudioRecord / iOS input tap → RawOutgoingAudioStream (no Cloudflare audio).
 * `"glasses"` = today's glasses WHIP → Cloudflare → WHEP PCM → ACS path.
 * preferred_mic does not govern this call.
 */
export const ACS_CALL_MIC: AcsAudioSource = "glasses"

export type ResolvedAudioSource = {
  source: AcsAudioSource
  reason: SourceReason
}

function mapMic(value: string | null | undefined): AcsAudioSource | null {
  if (value === "phone" || value === "bluetooth" || value === "bluetoothClassic") return "phone"
  if (value === "glasses") return "glasses"
  return null
}

/**
 * Pure preferred_mic → ACS source mapping. Store reads stay in the thin wrapper
 * so this table can be unit tested without zustand.
 */
export function resolveAudioSource(input: {
  preferred: string
  currentMic: string | null
  micRanking: string[]
  glassesConnected: boolean
}): ResolvedAudioSource {
  const preferred = input.preferred || "auto"
  if (preferred === "phone" || preferred === "bluetooth") {
    return {source: "phone", reason: "explicit"}
  }
  if (preferred === "glasses") {
    return {source: "glasses", reason: "explicit"}
  }
  const fromCurrent = mapMic(input.currentMic)
  if (fromCurrent) return {source: fromCurrent, reason: "current-mic"}
  const fromRank = mapMic(input.micRanking[0])
  if (fromRank) return {source: fromRank, reason: "ranking"}
  return input.glassesConnected
    ? {source: "glasses", reason: "fallback-glasses-connected"}
    : {source: "phone", reason: "fallback-no-glasses"}
}
