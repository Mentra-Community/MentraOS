import type {AudioSource} from "expo-audio"

/**
 * A tiny bundled source used to detach completed or interrupted audio without
 * destroying the reusable native player. If a media control later sends Play,
 * only this silence can be resumed instead of the previous miniapp audio.
 */
export const SILENT_AUDIO_SOURCE: AudioSource = require("../assets/silence.wav")
