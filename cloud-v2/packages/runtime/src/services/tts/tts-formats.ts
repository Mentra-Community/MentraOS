/**
 * @fileoverview Audio encodings the runtime TTS route can return.
 *
 * `mp3` is the default so older hosts keep working. `pcm_24000` is raw signed
 * 16-bit little-endian mono PCM at 24 kHz, for hosts that stream it straight
 * into a PCM player.
 */
export const TTS_AUDIO_FORMATS = {
  mp3: { contentType: "audio/mpeg" },
  pcm_24000: { contentType: "audio/pcm;encoding=s16le;rate=24000;channels=1" },
} as const;

export type TtsAudioFormat = keyof typeof TTS_AUDIO_FORMATS;

export const DEFAULT_TTS_AUDIO_FORMAT: TtsAudioFormat = "mp3";

export function isTtsAudioFormat(value: string): value is TtsAudioFormat {
  return Object.prototype.hasOwnProperty.call(TTS_AUDIO_FORMATS, value);
}
