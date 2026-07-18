import type {NavStatus, UnitSystem, VoiceGuidanceMode} from "../../shared/types"

export type AudioTravelMode = "walking" | "driving" | "cycling" | "two_wheeler"

type SpeakerPort = {
  speak(
    text: string,
    options?: {stopOtherAudio?: boolean; voice_settings?: Record<string, unknown>},
  ): Promise<{completed: boolean}>
  stop(): void
}

export type AudioGuidanceInput = {
  status: NavStatus
  running: boolean
  routeRevision: number
  pivotIndex: number | null
  maneuverType: string | null
  instruction: string | null
  distanceMeters: number | null
  destinationName: string | null
  arrivalSide: "left" | "right" | null
  travelMode: AudioTravelMode
  unitSystem: UnitSystem
}

type Prompt = {
  text: string
  priority: number
  expiresAt: number
  maneuverKey?: string
}

type Thresholds = {prepareMeters: number; nowMeters: number}

const THRESHOLDS: Record<AudioTravelMode, Thresholds> = {
  walking: {prepareMeters: 60, nowMeters: 10},
  cycling: {prepareMeters: 200, nowMeters: 25},
  driving: {prepareMeters: 500, nowMeters: 60},
  two_wheeler: {prepareMeters: 350, nowMeters: 50},
}

const MIN_AUTOMATIC_PROMPT_GAP_MS = 3_500
const TURN_TYPES = new Set([
  "TURN_LEFT",
  "TURN_RIGHT",
  "SLIGHT_LEFT",
  "SLIGHT_RIGHT",
  "SHARP_LEFT",
  "SHARP_RIGHT",
  "U_TURN",
  "CROSS_STREET",
])

/**
 * Converts the navigation engine's ~1 Hz/per-metre progress stream into a
 * deliberately sparse spoken experience: one preparation prompt and one
 * action prompt per maneuver, plus deduplicated lifecycle alerts.
 */
export class AudioGuidanceManager {
  private available = false
  private mode: VoiceGuidanceMode = "off"
  private tripActive = false
  private lastStatus: NavStatus = "idle"
  private currentManeuverKey: string | null = null
  private currentRepeatPhrase: string | null = null
  private lastSignature = ""
  private lastDistance: number | null = null
  private syntheticSequence = 0
  private spokenStages = new Set<string>()
  private speakingGeneration = 0
  private speaking = false
  private pending: Prompt | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private lastPromptStartedAt = 0
  private disposed = false

  constructor(
    private readonly speaker: SpeakerPort,
    private readonly log: (message: string) => void = () => {},
  ) {}

  setAvailable(available: boolean): void {
    this.available = available
    if (!available) this.stopSpeech()
  }

  setMode(mode: VoiceGuidanceMode): void {
    this.mode = mode
    if (mode === "off") this.stopSpeech()
  }

  beginTrip(): void {
    this.tripActive = true
    this.lastStatus = "navigating"
    this.resetManeuverState()
  }

  confirmTripStarted(destinationName: string | null): void {
    if (!this.canSpeak()) return
    const destination = cleanSpokenText(destinationName)
    this.enqueue({
      text: destination ? `Navigation started to ${destination}.` : "Navigation started.",
      priority: 50,
      expiresAt: Date.now() + 12_000,
    })
  }

  observe(input: AudioGuidanceInput): void {
    if (this.disposed) return

    if (!input.running && input.status === "idle") {
      if (this.tripActive) this.endTrip()
      this.lastStatus = input.status
      return
    }

    if (input.status === "rerouting" && this.lastStatus !== "rerouting") {
      this.currentManeuverKey = null
      this.currentRepeatPhrase = "Rerouting."
      this.enqueue({text: "Off route. Rerouting.", priority: 100, expiresAt: Date.now() + 10_000})
    }

    if (input.status === "arrived" && this.lastStatus !== "arrived") {
      const destination = cleanSpokenText(input.destinationName)
      const side = input.arrivalSide ? `, on your ${input.arrivalSide}` : ""
      const phrase = destination ? `You have arrived at ${destination}${side}.` : `You have arrived${side}.`
      this.currentManeuverKey = null
      this.currentRepeatPhrase = phrase
      this.enqueue({text: phrase, priority: 110, expiresAt: Date.now() + 20_000})
      this.tripActive = false
    }

    this.lastStatus = input.status
    if (!input.running || input.status !== "navigating") return
    this.tripActive = true

    const instruction = cleanSpokenText(input.instruction)
    const maneuverType = input.maneuverType?.toUpperCase() ?? null
    const distance = validDistance(input.distanceMeters)
    if (!instruction || !maneuverType || maneuverType === "ARRIVE") return

    const signature = `${input.routeRevision}|${maneuverType}|${instruction.toLowerCase()}`
    const thresholds = THRESHOLDS[input.travelMode]
    if (
      input.pivotIndex == null &&
      signature === this.lastSignature &&
      distance != null &&
      this.lastDistance != null &&
      distance > this.lastDistance + Math.max(25, thresholds.prepareMeters / 2)
    ) {
      // Consecutive identical turns without pivot metadata: the native engine
      // advances by jumping from a near-zero distance to the next turn's much
      // larger distance. Treat that rebound as a new semantic maneuver.
      this.syntheticSequence += 1
    }
    this.lastSignature = signature
    this.lastDistance = distance

    const maneuverKey = `${signature}|${input.pivotIndex ?? `synthetic-${this.syntheticSequence}`}`
    if (maneuverKey !== this.currentManeuverKey) {
      this.currentManeuverKey = maneuverKey
      this.pending = this.pending?.maneuverKey ? null : this.pending
    }

    const preparePhrase = buildPreparationPhrase(instruction, distance, input.unitSystem)
    const nowPhrase = buildNowPhrase(instruction, maneuverType)
    this.currentRepeatPhrase =
      distance != null && distance <= thresholds.nowMeters && TURN_TYPES.has(maneuverType) ? nowPhrase : preparePhrase

    if (!this.canSpeak()) return

    const nowStage = `${maneuverKey}|now`
    if (
      TURN_TYPES.has(maneuverType) &&
      distance != null &&
      distance <= thresholds.nowMeters &&
      !this.spokenStages.has(nowStage)
    ) {
      this.spokenStages.add(nowStage)
      this.enqueue({
        text: nowPhrase,
        priority: 90,
        expiresAt: Date.now() + 7_000,
        maneuverKey,
      })
      return
    }

    const prepareStage = `${maneuverKey}|prepare`
    if (
      this.mode === "full" &&
      distance != null &&
      distance <= thresholds.prepareMeters &&
      distance > thresholds.nowMeters &&
      !this.spokenStages.has(prepareStage)
    ) {
      this.spokenStages.add(prepareStage)
      this.enqueue({
        text: preparePhrase,
        priority: 30,
        expiresAt: Date.now() + 15_000,
        maneuverKey,
      })
    }
  }

  repeatCurrent(): boolean {
    if (!this.canSpeak() || !this.tripActive || !this.currentRepeatPhrase) return false
    this.enqueue({
      text: this.currentRepeatPhrase,
      priority: 95,
      expiresAt: Date.now() + 8_000,
      maneuverKey: this.currentManeuverKey ?? undefined,
    })
    return true
  }

  endTrip(): void {
    this.tripActive = false
    this.lastStatus = "idle"
    this.currentRepeatPhrase = null
    this.resetManeuverState()
    this.stopSpeech()
  }

  dispose(): void {
    this.disposed = true
    this.endTrip()
  }

  private canSpeak(): boolean {
    return !this.disposed && this.available && this.mode !== "off"
  }

  private resetManeuverState(): void {
    this.currentManeuverKey = null
    this.lastSignature = ""
    this.lastDistance = null
    this.syntheticSequence = 0
    this.spokenStages.clear()
    this.pending = null
    this.clearPendingTimer()
  }

  private enqueue(prompt: Prompt): void {
    if (!this.canSpeak() || !prompt.text) return
    if (prompt.priority >= 90 && this.speaking) {
      this.pending = null
      this.clearPendingTimer()
      this.speaker.stop()
      this.startPrompt(prompt)
      return
    }

    if (this.speaking) {
      if (!this.pending || prompt.priority >= this.pending.priority) this.pending = prompt
      return
    }

    const gap = prompt.priority >= 90 ? 0 : MIN_AUTOMATIC_PROMPT_GAP_MS
    const wait = Math.max(0, this.lastPromptStartedAt + gap - Date.now())
    if (wait > 0) {
      if (!this.pending || prompt.priority >= this.pending.priority) this.pending = prompt
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null
          this.drainPending()
        }, wait)
      }
      return
    }
    this.startPrompt(prompt)
  }

  private startPrompt(prompt: Prompt): void {
    if (!this.isPromptValid(prompt)) return
    const generation = ++this.speakingGeneration
    this.speaking = true
    this.lastPromptStartedAt = Date.now()
    this.log(`VOICE ${prompt.text}`)
    void this.speaker
      .speak(prompt.text, {
        // The host's playback session ducks external media. Do not abort other
        // miniapp streams merely to deliver a short navigation cue.
        stopOtherAudio: false,
        voice_settings: {speed: 1.05},
      })
      .catch((err) => {
        this.log(`VOICE failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        if (generation !== this.speakingGeneration) return
        this.speaking = false
        this.drainPending()
      })
  }

  private drainPending(): void {
    if (this.speaking) return
    const next = this.pending
    this.pending = null
    if (!next || !this.isPromptValid(next)) return
    this.enqueue(next)
  }

  private isPromptValid(prompt: Prompt): boolean {
    if (!this.canSpeak() || Date.now() > prompt.expiresAt) return false
    return !prompt.maneuverKey || prompt.maneuverKey === this.currentManeuverKey
  }

  private stopSpeech(): void {
    this.pending = null
    this.clearPendingTimer()
    this.speakingGeneration += 1
    if (this.speaking) this.speaker.stop()
    this.speaking = false
  }

  private clearPendingTimer(): void {
    if (!this.pendingTimer) return
    clearTimeout(this.pendingTimer)
    this.pendingTimer = null
  }
}

function validDistance(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null
}

function cleanSpokenText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\n\r]+/g, " ")
    .replace(/[←→↑↺↰↱↖↗⤴⤵●⇆]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim()
}

function buildPreparationPhrase(instruction: string, distanceMeters: number | null, unit: UnitSystem): string {
  if (distanceMeters == null) return `${capitalize(instruction)}.`
  return `In ${formatSpokenDistance(distanceMeters, unit)}, ${lowercaseFirst(instruction)}.`
}

function buildNowPhrase(instruction: string, maneuverType: string): string {
  if (maneuverType === "CROSS_STREET") return "Cross the street now."
  if (maneuverType === "U_TURN") return "Turn around now."
  return `${capitalize(instruction)} now.`
}

function formatSpokenDistance(meters: number, unit: UnitSystem): string {
  if (unit === "imperial") {
    const feet = meters * 3.28084
    if (feet < 528) return `${Math.max(10, Math.round(feet / 10) * 10)} feet`
    const miles = feet / 5280
    return `${miles.toFixed(1)} ${miles >= 0.95 && miles < 1.05 ? "mile" : "miles"}`
  }
  if (meters < 1000) {
    const rounded = meters < 100 ? Math.max(5, Math.round(meters / 5) * 5) : Math.round(meters / 10) * 10
    return `${rounded} meters`
  }
  const kilometers = meters / 1000
  return `${kilometers.toFixed(1)} ${kilometers >= 0.95 && kilometers < 1.05 ? "kilometer" : "kilometers"}`
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function lowercaseFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value
}
