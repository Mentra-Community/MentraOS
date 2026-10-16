/**
 * Pure helpers for the iPhone Pair Audio fallback (spec S6). Kept free of React Native imports so
 * the audio decision is unit-testable on its own.
 */

export const BT_CLASSIC_ROUTE = "/pairing/btclassic"

/**
 * When the glasses derive Classic audio from the LE pair (`pairing_info.auto_audio === true`), audio
 * should connect on its own. The loading screen waits this long, then re-checks the real audio state
 * before it opens Pair Audio.
 */
export const AUTO_AUDIO_WAIT_MS = 30_000

/**
 * After the app link to the glasses comes up, iOS reconnects the Classic audio route on its own a
 * few seconds later (about 3.5 s in a 2026-10-16 iPhone log). The home screen waits this long, with
 * audio still down, before it tells the user the audio device is disconnected.
 */
export const AUDIO_RECONNECT_GRACE_MS = 10_000

export type AudioReadiness = {
  bluetoothClassicConnected: boolean
  bluetoothClassicProfilesConnected: boolean
  bluetoothAudioRouted: boolean
}

/** Audio is up when the Classic bond, the connected profiles or the audio route says so. */
export const isClassicAudioUp = (readiness: AudioReadiness): boolean =>
  readiness.bluetoothClassicConnected || readiness.bluetoothClassicProfilesConnected || readiness.bluetoothAudioRouted

/** Pair Audio exists only for Mentra Live on iPhone. Android attaches Classic from the BLE bond. */
export const needsPairAudioCheck = (platform: string, deviceModel: string): boolean =>
  platform === "ios" && deviceModel === "Mentra Live"

/**
 * `done`: nothing to do (not iOS Mentra Live, or audio is already up, whatever `auto_audio` says).
 * `wait`: audio is down and the glasses say it will connect by itself, so wait up to
 *   `AUTO_AUDIO_WAIT_MS`, then ask again with `waitElapsed`.
 * `pair_audio`: open Pair Audio now.
 */
export type PairAudioDecision = "done" | "wait" | "pair_audio"

export const decidePairAudio = ({
  platform,
  deviceModel,
  readiness,
  autoAudio,
  waitElapsed,
}: {
  platform: string
  deviceModel: string
  readiness: AudioReadiness
  autoAudio: boolean | undefined
  waitElapsed: boolean
}): PairAudioDecision => {
  if (!needsPairAudioCheck(platform, deviceModel)) return "done"
  if (isClassicAudioUp(readiness)) return "done"
  if (autoAudio === true && !waitElapsed) return "wait"
  return "pair_audio"
}
