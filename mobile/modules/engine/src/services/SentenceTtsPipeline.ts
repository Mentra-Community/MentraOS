export interface SentenceAudio {
  audioUrl: string
  cleanup?: () => Promise<void> | void
}

export interface SentencePlaybackResult {
  success: boolean
  completed: boolean
  error: string | null
  duration: number | null
}

export interface SentencePipelineRun {
  cancelled: boolean
}

interface SentenceTtsPipelineOptions {
  sentences: string[]
  firstAudio: SentenceAudio
  run: SentencePipelineRun
  synthesize: (sentence: string) => Promise<SentenceAudio>
  play: (audio: SentenceAudio, index: number) => Promise<SentencePlaybackResult>
  onCleanupError?: (error: unknown) => void
}

async function cleanupAudio(audio: SentenceAudio, onError?: (error: unknown) => void): Promise<void> {
  try {
    await Promise.resolve(audio.cleanup?.())
  } catch (error) {
    onError?.(error)
  }
}

/**
 * Play pre-segmented TTS with one-sentence lookahead.
 *
 * The next sentence begins synthesis before playback of the current sentence,
 * minimizing the transition delay without requiring incremental waveform
 * support from the TTS model.
 */
export async function runSentenceTtsPipeline({
  sentences,
  firstAudio,
  run,
  synthesize,
  play,
  onCleanupError,
}: SentenceTtsPipelineOptions): Promise<SentencePlaybackResult> {
  let current = firstAudio
  let totalDuration = 0

  for (let index = 0; index < sentences.length; index++) {
    if (run.cancelled) {
      await cleanupAudio(current, onCleanupError)
      return {success: true, completed: false, error: null, duration: totalDuration}
    }

    // Attach both handlers immediately so a fast native rejection cannot
    // become an unhandled promise while the current sentence is playing.
    const nextOutcome =
      index + 1 < sentences.length
        ? synthesize(sentences[index + 1]).then(
            (audio) => ({audio, error: null}),
            (error: unknown) => ({audio: null, error}),
          )
        : null

    const playback = await play(current, index)
    totalDuration += playback.duration ?? 0
    await cleanupAudio(current, onCleanupError)

    if (run.cancelled) {
      if (nextOutcome) {
        void nextOutcome.then(({audio}) => {
          if (audio) void cleanupAudio(audio, onCleanupError)
        })
      }
      return {success: true, completed: false, error: null, duration: totalDuration}
    }
    if (!playback.success || !playback.completed) {
      if (nextOutcome) {
        void nextOutcome.then(({audio}) => {
          if (audio) void cleanupAudio(audio, onCleanupError)
        })
      }
      return playback
    }
    if (!nextOutcome) {
      return {success: true, completed: true, error: null, duration: totalDuration}
    }

    const next = await nextOutcome
    if (!next.audio) {
      const message = next.error instanceof Error ? next.error.message : String(next.error)
      return {
        success: false,
        completed: false,
        error: `Offline TTS failed for sentence ${index + 2}: ${message}`,
        duration: totalDuration,
      }
    }
    current = next.audio
  }

  return {success: true, completed: true, error: null, duration: totalDuration}
}
