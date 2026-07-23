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
  offRoute: boolean
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
const STARTUP_OFF_ROUTE_GRACE_MS = 15_000
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
  private tripConfirmed = false
  private tripStartedAt: number | null = null
  private startupOffRouteSuppressed = false
  private startupRerouteSuppressed = false
  private allowImplicitResume = true
  private latestUnconfirmedInput: AudioGuidanceInput | null = null
  private lastStatus: NavStatus = "idle"
  private lastOffRoute = false
  private currentManeuverKey: string | null = null
  private currentPivotIndex: number | null = null
  private currentRepeatPhrase: string | null = null
  private lastSignature = ""
  private lastDistance: number | null = null
  private syntheticSequence = 0
  private spokenStages = new Set<string>()
  private speakingGeneration = 0
  private speaking = false
  private speakingPriority = 0
  private speakingManeuverKey: string | null = null
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
    this.stopSpeech()
    this.tripActive = true
    this.tripConfirmed = false
    this.tripStartedAt = null
    this.startupOffRouteSuppressed = false
    this.startupRerouteSuppressed = false
    this.allowImplicitResume = false
    this.latestUnconfirmedInput = null
    this.lastStatus = "navigating"
    this.lastOffRoute = false
    this.resetManeuverState()
  }

  confirmTripStarted(destinationName: string | null): void {
    if (!this.tripActive) return
    this.tripConfirmed = true
    this.tripStartedAt = Date.now()
    if (this.canSpeak()) {
      const destination = cleanSpokenText(destinationName)
      this.enqueue({
        text: destination ? `Navigation started to ${destination}.` : "Navigation started.",
        // Lead the first maneuver cue, but still allow arrival to interrupt.
        priority: 100,
        expiresAt: Date.now() + 12_000,
      })
    }
    const latest = this.latestUnconfirmedInput
    this.latestUnconfirmedInput = null
    if (latest) this.observe(latest)
  }

  observe(input: AudioGuidanceInput): void {
    if (this.disposed) return

    if (!input.running && input.status === "idle") {
      if (this.tripActive) this.endTrip()
      this.lastStatus = input.status
      return
    }

    // Keep the manager usable for an already-running session restored by the
    // host, where beginTrip()/confirmTripStarted() did not occur in this JS
    // lifetime. Explicit new trips still enter the unconfirmed path below.
    if (this.allowImplicitResume && !this.tripActive && input.running && input.status === "navigating") {
      this.tripActive = true
      this.tripConfirmed = true
      this.tripStartedAt = null
      this.allowImplicitResume = false
    }
    if (!this.tripActive) {
      this.lastStatus = input.status
      return
    }

    // The native engine can emit its first maneuver before navigation.start()
    // resolves. Keep only the freshest update and replay it after the start
    // confirmation so spoken guidance never leads with a turn instruction.
    if (this.tripActive && !this.tripConfirmed) {
      this.latestUnconfirmedInput = input
      return
    }

    const startupOffRouteGraceActive = this.isStartupOffRouteGraceActive()
    const enteredRerouting = input.status === "rerouting" && this.lastStatus !== "rerouting"
    const deferredStartupReroute =
      input.status === "rerouting" && this.startupRerouteSuppressed && !startupOffRouteGraceActive
    if (enteredRerouting || deferredStartupReroute) {
      this.discardStaleManeuverPrompts()
      this.currentManeuverKey = null
      this.currentRepeatPhrase = "Rerouting."
      if (startupOffRouteGraceActive) {
        this.startupRerouteSuppressed = true
      } else {
        this.startupRerouteSuppressed = false
        this.enqueue({text: "Off route. Rerouting.", priority: 100, expiresAt: Date.now() + 10_000})
      }
    } else if (input.status !== "rerouting") {
      this.startupRerouteSuppressed = false
    }

    if (input.status === "arrived" && this.lastStatus !== "arrived") {
      const destination = cleanSpokenText(input.destinationName)
      const side = input.arrivalSide ? `, on your ${input.arrivalSide}` : ""
      const phrase = destination ? `You have arrived at ${destination}${side}.` : `You have arrived${side}.`
      this.currentManeuverKey = null
      this.currentRepeatPhrase = phrase
      this.enqueue({text: phrase, priority: 110, expiresAt: Date.now() + 20_000})
      this.tripActive = false
      this.allowImplicitResume = false
      this.lastOffRoute = false
    }

    this.lastStatus = input.status
    if (!input.running || input.status !== "navigating") return
    this.tripActive = true

    // A route can initially snap to a walkable road tens of metres from an
    // indoor or noisy GPS fix. Keep real rerouting active, but do not speak
    // either an off-route warning or maneuver guidance derived from that
    // unstable fix. A stable on-route update resumes the current maneuver
    // afresh; if the condition persists past the grace period, the normal
    // one-shot warning becomes eligible.
    if (input.offRoute && startupOffRouteGraceActive) {
      if (!this.startupOffRouteSuppressed) {
        this.discardStaleManeuverPrompts()
        this.currentManeuverKey = null
        this.currentPivotIndex = null
        this.currentRepeatPhrase = null
      }
      this.startupOffRouteSuppressed = true
      return
    }
    if (input.offRoute) {
      this.startupOffRouteSuppressed = false
      if (!this.lastOffRoute) {
        const phrase = "You are off route. Go back to the route."
        this.discardStaleManeuverPrompts()
        this.currentManeuverKey = null
        this.currentRepeatPhrase = phrase
        this.enqueue({text: phrase, priority: 100, expiresAt: Date.now() + 12_000})
      }
      this.lastOffRoute = true
      return
    }
    if (this.lastOffRoute || this.startupOffRouteSuppressed) {
      // Returning to the route should evaluate the current maneuver afresh;
      // stages spoken before the deviation no longer describe the live spot.
      this.currentManeuverKey = null
      this.currentPivotIndex = null
    }
    this.startupOffRouteSuppressed = false
    this.lastOffRoute = false

    const instruction = cleanSpokenText(input.instruction)
    const maneuverType = input.maneuverType?.toUpperCase() ?? null
    const distance = validDistance(input.distanceMeters)
    if (!instruction || !maneuverType) return

    const signature = `${input.routeRevision}|${maneuverType}|${instruction.toLowerCase()}`
    const thresholds = THRESHOLDS[input.travelMode]
    // Consecutive identical turns without pivot metadata advance by jumping
    // from a near-zero distance to the next turn's much larger distance.
    const previousNowSpoken =
      this.currentManeuverKey != null && this.spokenStages.has(`${this.currentManeuverKey}|now`)
    const distanceRebounded =
      input.pivotIndex == null &&
      signature === this.lastSignature &&
      distance != null &&
      this.lastDistance != null &&
      (distance > this.lastDistance + Math.max(25, thresholds.prepareMeters / 2) ||
        (previousNowSpoken &&
          distance > thresholds.nowMeters &&
          distance > this.lastDistance + Math.max(10, thresholds.nowMeters / 2)))

    const pivotChanged =
      this.currentPivotIndex != null && input.pivotIndex != null && input.pivotIndex !== this.currentPivotIndex
    const newSemanticManeuver =
      this.currentManeuverKey == null || signature !== this.lastSignature || pivotChanged || distanceRebounded
    if (newSemanticManeuver) {
      this.discardStaleManeuverPrompts()
      this.syntheticSequence += 1
      this.currentManeuverKey = `${signature}|semantic-${this.syntheticSequence}`
      this.currentPivotIndex = input.pivotIndex
    } else if (this.currentPivotIndex == null && input.pivotIndex != null) {
      // The same maneuver first arrived before PivotEngine bound metadata.
      // Attach the pivot without changing its identity or replaying stages.
      this.currentPivotIndex = input.pivotIndex
    }
    this.lastSignature = signature
    this.lastDistance = distance
    const maneuverKey = this.currentManeuverKey
    if (!maneuverKey) return

    const preparePhrase = buildPreparationPhrase(instruction, distance, input.unitSystem)
    const nowPhrase = buildNowPhrase(instruction, maneuverType)

    if (maneuverType === "ARRIVE") {
      const approachPhrase =
        distance == null ? "Approaching your destination." : `Destination in ${formatSpokenDistance(distance, input.unitSystem)}.`
      this.currentRepeatPhrase = approachPhrase
      const approachStage = `${maneuverKey}|prepare`
      if (
        this.canSpeak() &&
        this.mode === "full" &&
        distance != null &&
        distance <= thresholds.prepareMeters &&
        !this.spokenStages.has(approachStage)
      ) {
        this.spokenStages.add(approachStage)
        this.enqueue({
          text: approachPhrase,
          priority: 30,
          expiresAt: Date.now() + 15_000,
          maneuverKey,
        })
      }
      return
    }

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
      !this.spokenStages.has(nowStage) &&
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
    this.tripConfirmed = false
    this.tripStartedAt = null
    this.startupOffRouteSuppressed = false
    this.startupRerouteSuppressed = false
    this.allowImplicitResume = false
    this.latestUnconfirmedInput = null
    this.lastStatus = "idle"
    this.lastOffRoute = false
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

  private isStartupOffRouteGraceActive(): boolean {
    return this.tripStartedAt != null && Date.now() - this.tripStartedAt < STARTUP_OFF_ROUTE_GRACE_MS
  }

  private resetManeuverState(): void {
    this.currentManeuverKey = null
    this.currentPivotIndex = null
    this.currentRepeatPhrase = null
    this.lastSignature = ""
    this.lastDistance = null
    this.syntheticSequence = 0
    this.spokenStages.clear()
    this.pending = null
    this.clearPendingTimer()
  }

  private enqueue(prompt: Prompt): void {
    if (!this.canSpeak() || !prompt.text) return
    if (prompt.priority >= 90) {
      // An action/repeat/lifecycle cue supersedes deferred advance notice.
      // Otherwise a prepare prompt waiting out the automatic gap can fire
      // after "turn now", when it is both stale and actively confusing.
      this.pending = null
      this.clearPendingTimer()
      if (this.speaking && prompt.priority >= this.speakingPriority) {
        this.speaker.stop()
        this.startPrompt(prompt)
        return
      }
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
    this.speakingPriority = prompt.priority
    this.speakingManeuverKey = prompt.maneuverKey ?? null
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
        this.speakingPriority = 0
        this.speakingManeuverKey = null
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

  private discardStaleManeuverPrompts(): void {
    if (this.pending?.maneuverKey) {
      this.pending = null
      this.clearPendingTimer()
    }
    if (!this.speaking || !this.speakingManeuverKey) return

    // A route/pivot change invalidates even an utterance that has already
    // started. Interrupt only maneuver-bound speech; lifecycle cues such as
    // "Navigation started" deliberately have no maneuver key and continue.
    this.speakingGeneration += 1
    this.speaker.stop()
    this.speaking = false
    this.speakingPriority = 0
    this.speakingManeuverKey = null
  }

  private stopSpeech(): void {
    this.pending = null
    this.clearPendingTimer()
    this.speakingGeneration += 1
    if (this.speaking) this.speaker.stop()
    this.speaking = false
    this.speakingPriority = 0
    this.speakingManeuverKey = null
  }

  private clearPendingTimer(): void {
    if (!this.pendingTimer) return
    clearTimeout(this.pendingTimer)
    this.pendingTimer = null
  }
}

/**
 * Arrival guidance follows the live destination countdown, while turn cues
 * stay paired with the native event that supplied their type and instruction.
 */
export function selectAudioGuidanceDistance(
  maneuverType: string | null | undefined,
  eventDistanceMeters: number | null | undefined,
  liveDisplayDistanceMeters: number | null | undefined,
): number | null {
  const eventDistance = validDistance(eventDistanceMeters ?? null)
  if (maneuverType?.toUpperCase() !== "ARRIVE") return eventDistance
  return validDistance(liveDisplayDistanceMeters ?? null) ?? eventDistance
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
