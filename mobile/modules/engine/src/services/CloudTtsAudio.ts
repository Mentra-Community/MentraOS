import {File, Paths} from "expo-file-system"

import type {TtsSynthesisResult} from "../runtime/config"
import {BgTimer} from "../utils/timers"

const LOG_TAG = "CLOUD_TTS"
/** A typical spoken reply keeps the five-second budget cloud speech had to start playing. */
const DOWNLOAD_BASE_TIMEOUT_MS = 5000
/** Synthesis and transfer grow with the text: 1,800 characters took about 2.4s on a fast link. */
const DOWNLOAD_TIMEOUT_MS_PER_CHAR = 3

export function cloudTtsDownloadTimeoutMs(text: string): number {
  return DOWNLOAD_BASE_TIMEOUT_MS + text.length * DOWNLOAD_TIMEOUT_MS_PER_CHAR
}

function deleteFile(file: File): void {
  try {
    if (file.exists) file.delete()
  } catch (error) {
    console.warn(`${LOG_TAG}: failed to delete ${file.uri}:`, error)
  }
}

/**
 * Fetch cloud speech into a local file so playback starts from complete audio.
 *
 * The runtime relays ElevenLabs' MP3 stream without a length or byte-range
 * support. Handed that URL, AVPlayer probes it with `Range: bytes=0-1`,
 * cancels the full synthesis the server answers with, and reopens it as a
 * live ICY stream: every utterance is synthesized twice, and playback begins
 * from a network-fed buffer that can stall past the startup deadline or
 * underrun at the start, clipping the first words on glasses. One download
 * synthesizes once, and the player starts from a local file the same way it
 * plays offline speech.
 */
export async function downloadCloudTtsAudio(audioUrl: string, timeoutMs: number): Promise<TtsSynthesisResult> {
  const file = new File(Paths.cache, `mentra_cloud_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`)
  const startedAt = Date.now()
  const download = File.downloadFileAsync(audioUrl, file, {idempotent: true})

  let rejectDeadline!: (error: Error) => void
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  const timer = BgTimer.setTimeout(() => {
    rejectDeadline(new Error(`Cloud TTS download did not finish within ${timeoutMs}ms`))
  }, timeoutMs)

  try {
    await Promise.race([download, deadline])
  } catch (error) {
    // The native download cannot be cancelled; remove its file whenever it lands.
    void download.then(
      () => deleteFile(file),
      () => deleteFile(file),
    )
    throw error
  } finally {
    BgTimer.clearTimeout(timer)
  }

  const bytes = file.size
  if (!bytes) {
    deleteFile(file)
    throw new Error("Cloud TTS download returned no audio")
  }
  console.log(`${LOG_TAG}: downloaded ${bytes}B in ${Date.now() - startedAt}ms`)
  return {audioUrl: file.uri, cleanup: () => deleteFile(file)}
}
