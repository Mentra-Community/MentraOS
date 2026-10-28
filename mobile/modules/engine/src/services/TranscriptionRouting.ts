/**
 * Where each miniapp transcription listener gets its text: the cloud or the
 * phone's on-device recognizer.
 *
 * A listener asks for one of three behaviours (the SDK's `processing`):
 *   - preferCloud (default): the cloud; on-device only while the cloud is
 *     unreachable.
 *   - preferLocal: on-device while the running model transcribes the
 *     listener's language, otherwise the cloud.
 *   - localOnly: on-device only; never the cloud.
 *
 * Each listener receives one source at a time (`handoffStep`). A planned
 * switch, while its current source still works, waits for a pause in which
 * both sources have settled (`UtteranceTracker`), then for a drain of the
 * on-device recognizer (it reports everything it heard so far and starts
 * over). The drain is the boundary: on-device text from before it stays with
 * the old side, on-device text after it is new speech, and the listener's
 * cloud text starts at the cloud audio position where the drain began. So a
 * listener never misses or repeats speech. A model that cannot be drained
 * leaves the quiet window as the boundary. A forced switch, when the current
 * source stops, happens at once; a move to the cloud then starts at the
 * cloud audio position of the last on-device final, so an utterance cut short
 * on-device is completed in the cloud and finished ones are not repeated.
 * The listeners' sources and targets decide what runs: a stream is requested
 * from the cloud only while a listener on it needs the cloud, and the
 * on-device recognizer runs only while a listener needs it.
 */

export type SpeechProcessing = "preferCloud" | "preferLocal" | "localOnly"
export type TranscriptionSource = "cloud" | "local"

const PROCESSING: ReadonlySet<unknown> = new Set<SpeechProcessing>(["preferCloud", "preferLocal", "localOnly"])
const AUTO_STREAM = "transcription:auto"
const STREAM_PREFIX = "transcription:"

/**
 * A source has settled once it has produced nothing for this long since its
 * last final (or since it started): a pause in speech, longer than the
 * recognizers' own end-of-speech delays.
 */
export const SOURCE_QUIET_MS = 3000
/** An utterance whose final never came has ended after this long without transcripts. */
export const UTTERANCE_STALE_MS = 6000

/**
 * The processing a listener, subscription or speak request asks for.
 * `processing` wins; without it, the `forceLocal: true` of SDKs before it
 * means localOnly. Anything else is preferCloud.
 */
export function readSpeechProcessing(request: {processing?: unknown; forceLocal?: unknown}): SpeechProcessing {
  if (PROCESSING.has(request.processing)) return request.processing as SpeechProcessing
  return request.forceLocal === true ? "localOnly" : "preferCloud"
}

export interface RoutedListener {
  /** `transcription:<language>` or `transcription:auto`. */
  stream: string
  processing: SpeechProcessing
}

/** What the phone can transcribe with right now, as one miniapp sees it. */
export interface TranscriptionRoutingState {
  cloudConnected: boolean
  /** On-device speech is allowed by this deployment. */
  onDevice: boolean
  /** BCP-47 language of the running on-device model, or null while none runs. */
  localLanguage: string | null
  /** BCP-47 language of the model picked on the Speech page. */
  pickedLanguage: string
  /** The miniapp's language hints (bare codes, from transcription.configure). */
  hints: readonly string[]
}

/**
 * Whether an on-device model in `language` transcribes what the listener asks
 * for. A specific language must be the model's. Auto-detect follows the
 * model's language, the one the user picked; but a preferLocal listener whose
 * miniapp hinted at another language keeps the cloud, which tells them apart.
 */
export function onDeviceServes(listener: RoutedListener, language: string, hints: readonly string[]): boolean {
  const requested = listener.stream.slice(STREAM_PREFIX.length).toLowerCase()
  if (requested === language.toLowerCase()) return true
  if (listener.stream !== AUTO_STREAM) return false
  if (listener.processing !== "preferLocal") return true
  const base = language.split("-")[0].toLowerCase()
  return hints.every((hint) => hint.toLowerCase() === base)
}

/** The source the listener should receive now. */
export function targetSource(listener: RoutedListener, state: TranscriptionRoutingState): TranscriptionSource {
  if (listener.processing === "localOnly" || !state.cloudConnected) return "local"
  if (listener.processing === "preferCloud") return "cloud"
  return state.onDevice && state.localLanguage !== null && onDeviceServes(listener, state.localLanguage, state.hints)
    ? "local"
    : "cloud"
}

/**
 * What a listener on `current` does on its way to `target`:
 * - "settle": it has no source yet or is already there; take `target`.
 * - "forced": `current` can no longer deliver; move now.
 * - "wait": a source is still busy on its streams; stay.
 * - "drain": both settled, but the on-device recognizer has spoken since its
 *   last drain; stay until a drain completes.
 * - "planned": both settled and drained; move now.
 */
export type HandoffStep = "settle" | "forced" | "wait" | "drain" | "planned"

export function handoffStep(
  current: TranscriptionSource | null,
  target: TranscriptionSource,
  canDeliver: (source: TranscriptionSource) => boolean,
  busy: (source: TranscriptionSource) => boolean,
  drained: boolean,
): HandoffStep {
  if (current === null || current === target) return "settle"
  if (!canDeliver(current)) return "forced"
  if (busy(current) || busy(target)) return "wait"
  return drained ? "planned" : "drain"
}

/** Whether the listener needs its stream from the cloud. */
export function needsCloud(
  listener: RoutedListener,
  source: TranscriptionSource | null,
  target: TranscriptionSource,
): boolean {
  if (listener.processing === "localOnly") return false
  return listener.processing === "preferCloud" || source === "cloud" || target === "cloud"
}

/**
 * Whether the listener needs the on-device recognizer running. preferLocal
 * asks for it whenever the picked model transcribes its language, which is
 * what starts (and, when missing, downloads) that model.
 */
export function needsLocal(
  listener: RoutedListener,
  source: TranscriptionSource | null,
  state: TranscriptionRoutingState,
): boolean {
  if (source === "local" || listener.processing === "localOnly" || !state.cloudConnected) return true
  return (
    listener.processing === "preferLocal" &&
    state.onDevice &&
    onDeviceServes(listener, state.pickedLanguage, state.hints)
  )
}

/** When each source last produced a transcript on each stream, to tell when it has settled. */
export class UtteranceTracker {
  /** `${source} ${stream}` -> its last transcript; stream "*" marks a source start, for every stream. */
  private readonly last = new Map<string, {at: number; final: boolean}>()

  constructor(
    private readonly quietMs = SOURCE_QUIET_MS,
    private readonly staleMs = UTTERANCE_STALE_MS,
  ) {}

  /** Records a transcript: an interim opens (or continues) an utterance, a final ends it. */
  note(source: TranscriptionSource, stream: string, isFinal: boolean, now: number): void {
    this.last.set(`${source} ${stream}`, {at: now, final: isFinal})
  }

  /**
   * A source started (the cloud connected, or the on-device model loaded): it
   * may already be working on speech it has not reported, so it settles only
   * after a quiet window.
   */
  started(source: TranscriptionSource, now: number): void {
    this.clear(source)
    this.note(source, "*", true, now)
  }

  /** Forgets a source that stopped: it never reports anything more. */
  clear(source: TranscriptionSource): void {
    for (const key of [...this.last.keys()]) {
      if (key.startsWith(`${source} `)) this.last.delete(key)
    }
  }

  /** Whether `source` may still report speech that a listener on `stream` hears. */
  busy(source: TranscriptionSource, stream: string, now: number): boolean {
    for (const [key, last] of this.last) {
      if (now >= this.settlesAt(last)) continue
      const [keySource, keyStream] = key.split(" ")
      if (keySource !== source) continue
      if (keyStream === "*" || stream === AUTO_STREAM || keyStream === stream) return true
    }
    return false
  }

  /** When the next busy stream settles, or null when every one has. */
  nextSettle(now: number): number | null {
    let next: number | null = null
    for (const [key, last] of this.last) {
      const at = this.settlesAt(last)
      if (now >= at) this.last.delete(key)
      else if (next === null || at < next) next = at
    }
    return next
  }

  private settlesAt(last: {at: number; final: boolean}): number {
    return last.at + (last.final ? this.quietMs : this.staleMs)
  }
}
