import type {AudioPosition, TranscriptionToken} from "@mentra/cloud-protocol"
import {
  handoffStep,
  readSpeechProcessing,
  type RoutedListener,
  type SpeechProcessing,
  type TranscriptionSource,
} from "./TranscriptionRouting"

export interface TranscriptionListenerRegistration {
  id: string
  stream: string
  processing: SpeechProcessing
  /**
   * Registered for an SDK that predates listener ids. It gets un-addressed
   * events, which that SDK fans out to every listener of the same class, so
   * all of a class's legacy registrations move between sources together.
   */
  legacy?: boolean
}

/** A transcription stream's entry in SUBSCRIBE `subscriptions`. */
export interface TranscriptionStreamEntry {
  stream: string
  processing?: unknown
  /** SDKs before `processing`: the stream has localOnly listeners. */
  forceLocal?: unknown
  /** SDKs before `processing`, with forceLocal: the stream also has cloud listeners. */
  includeCloud?: unknown
}

/** Records what one transcription stream entry asks for. */
export function addStreamProcessing(
  byStream: Map<string, Set<SpeechProcessing>>,
  entry: TranscriptionStreamEntry,
): void {
  const processing = byStream.get(entry.stream) ?? new Set<SpeechProcessing>()
  byStream.set(entry.stream, processing)
  processing.add(readSpeechProcessing(entry))
  if (entry.processing === undefined && entry.forceLocal === true && entry.includeCloud === true) {
    processing.add("preferCloud")
  }
}

/**
 * The transcription listeners of one SUBSCRIBE. SDKs register each listener
 * (`transcriptionListeners`: `{id, stream, processing}`, or `forceLocal`
 * before `processing`). A subscribed stream without registered listeners, as
 * from SDKs that predate registration, gets one legacy registration per
 * processing its stream entries ask for.
 */
export function transcriptionRegistrations(
  registered: unknown,
  streams: string[],
  streamProcessing: Map<string, Set<SpeechProcessing>>,
): TranscriptionListenerRegistration[] {
  const subscribed = new Set(streams.filter((stream) => stream.startsWith("transcription:")))
  const registrations: TranscriptionListenerRegistration[] = []
  for (const value of Array.isArray(registered) ? registered : []) {
    if (typeof value !== "object" || value === null) continue
    const listener = value as {id?: unknown; stream?: unknown; processing?: unknown; forceLocal?: unknown}
    if (typeof listener.id !== "string" || typeof listener.stream !== "string") continue
    if (!subscribed.has(listener.stream)) continue
    registrations.push({id: listener.id, stream: listener.stream, processing: readSpeechProcessing(listener)})
  }
  const registeredStreams = new Set(registrations.map((registration) => registration.stream))
  for (const stream of subscribed) {
    if (registeredStreams.has(stream)) continue
    for (const processing of streamProcessing.get(stream) ?? ["preferCloud" as const]) {
      registrations.push({id: `legacy:${processing}:${stream}`, stream, processing, legacy: true})
    }
  }
  return registrations
}

/** What `TranscriptionSubscriptions.route` moves listeners by. */
export interface TranscriptionHandoff {
  target: (listener: RoutedListener) => TranscriptionSource
  canDeliver: (source: TranscriptionSource) => boolean
  /** Whether `source` is still busy on `stream` (see UtteranceTracker). */
  busy: (source: TranscriptionSource, stream: string) => boolean
  /** The on-device recognizer has been drained since it last spoke. */
  drained: boolean
  /** Cloud audio position where the last drain began. */
  plannedWatermark: AudioPosition | null
  /** Cloud audio position of the last on-device final. */
  forcedWatermark: AudioPosition | null
}

/**
 * Class an SDK from before `processing` filters routed events on: localOnly
 * listeners take "forceLocal", the others "default".
 */
export type TranscriptionDeliveryRoute = "default" | "forceLocal"

export interface TranscriptionDelivery {
  /** Absent for a legacy class: the SDK fans the event out by `route`. */
  listenerId?: string
  route: TranscriptionDeliveryRoute
  text: string
}

export interface TranscriptionListenerRoute extends RoutedListener {
  id: string
  /** Where the listener gets its text now; null before its first routing. */
  source: TranscriptionSource | null
  /** Where it is going (its source, unless a switch waits for a pause). */
  target: TranscriptionSource
}

interface Listener extends TranscriptionListenerRegistration {
  cutoff: AudioPosition | null
  sessions: Set<number>
}

interface GroupRoute {
  source: TranscriptionSource
  target: TranscriptionSource
}

/**
 * One miniapp's transcription listeners: which source each one gets its text
 * from, and its runtime-owned text projection. Token detail never crosses the
 * miniapp bridge.
 */
export class TranscriptionSubscriptions {
  private listeners = new Map<string, Listener>()
  /** Routing of each group: a listener, or one legacy class. */
  private routing = new Map<string, GroupRoute>()

  observe(current: AudioPosition | null): void {
    if (!current) return
    for (const listener of this.listeners.values()) listener.sessions.add(current.sessionTag)
  }

  replace(registrations: TranscriptionListenerRegistration[], cutoff: AudioPosition | null): void {
    this.observe(cutoff)
    const next = new Map<string, Listener>()
    for (const registration of registrations) {
      const existing = this.listeners.get(registration.id)
      next.set(
        registration.id,
        existing?.stream === registration.stream &&
          existing.processing === registration.processing &&
          !!existing.legacy === !!registration.legacy
          ? existing
          : {...registration, cutoff, sessions: new Set(cutoff ? [cutoff.sessionTag] : [])},
      )
    }
    this.listeners = next
    const groups = new Set([...next.values()].map(groupOf))
    for (const group of [...this.routing.keys()]) {
      if (!groups.has(group)) this.routing.delete(group)
    }
  }

  /**
   * Moves each group toward its target source (see `handoffStep`). A group
   * that moves from on-device to the cloud starts its positioned cloud text
   * at a watermark, so cloud tokens for speech it already got on-device are
   * never projected to it: where the drain began after a planned move, the
   * last on-device final after a forced one.
   */
  route(handoff: TranscriptionHandoff): {changed: boolean; needsDrain: boolean} {
    let changed = false
    let needsDrain = false
    for (const [group, members] of this.groups()) {
      // A legacy class moves on-device only when that serves all its streams.
      const target = members.every((member) => handoff.target(member) === "local") ? "local" : "cloud"
      const previous = this.routing.get(group)
      const step = handoffStep(
        previous?.source ?? null,
        target,
        handoff.canDeliver,
        (candidate) => members.some((member) => handoff.busy(candidate, member.stream)),
        handoff.drained,
      )
      if (step === "drain") needsDrain = true
      const source = step === "wait" || step === "drain" ? previous!.source : target
      if (previous?.source === source && previous.target === target) continue
      changed = true
      this.routing.set(group, {source, target})
      const watermark = step === "planned" ? handoff.plannedWatermark : handoff.forcedWatermark
      if (previous?.source === "local" && source === "cloud" && watermark) {
        for (const member of members) advanceCutoff(member, watermark)
      }
    }
    return {changed, needsDrain}
  }

  /** Whether a listener is waiting for its sources to settle before it switches. */
  switching(): boolean {
    for (const routing of this.routing.values()) {
      if (routing.source !== routing.target) return true
    }
    return false
  }

  /** Every listener with its current routing. */
  routes(): TranscriptionListenerRoute[] {
    return [...this.listeners.values()].map((listener) => {
      const routing = this.routing.get(groupOf(listener))
      return {
        id: listener.id,
        stream: listener.stream,
        processing: listener.processing,
        source: routing?.source ?? null,
        target: routing?.target ?? (listener.processing === "localOnly" ? "local" : "cloud"),
      }
    })
  }

  /**
   * The events one transcript produces for this miniapp: one per listener
   * that hears `stream` and currently gets its text from `source`. Cloud
   * transcripts with token positions are trimmed to what each listener may
   * hear; without positions (`tokens` undefined) the text goes as is.
   */
  deliveries(
    stream: string,
    source: TranscriptionSource,
    text: string,
    tokens: TranscriptionToken[] | undefined,
    current: AudioPosition | null,
  ): TranscriptionDelivery[] {
    this.observe(current)
    const deliveries: TranscriptionDelivery[] = []
    for (const listener of this.listeners.values()) {
      if (listener.stream !== stream && listener.stream !== "transcription:auto") continue
      if (this.routing.get(groupOf(listener))?.source !== source) continue
      const listenerText = tokens ? projectTokens(listener, tokens) : text
      if (tokens && !listenerText) continue
      const route: TranscriptionDeliveryRoute = listener.processing === "localOnly" ? "forceLocal" : "default"
      if (!listener.legacy) {
        deliveries.push({listenerId: listener.id, route, text: listenerText})
        continue
      }
      const existing = deliveries.find((delivery) => delivery.listenerId === undefined && delivery.route === route)
      if (!existing) deliveries.push({route, text: listenerText})
      else if (listenerText.length > existing.text.length) existing.text = listenerText
    }
    return deliveries
  }

  private groups(): Map<string, Listener[]> {
    const groups = new Map<string, Listener[]>()
    for (const listener of this.listeners.values()) {
      const group = groupOf(listener)
      const members = groups.get(group)
      if (members) members.push(listener)
      else groups.set(group, [listener])
    }
    return groups
  }
}

function groupOf(listener: TranscriptionListenerRegistration): string {
  return listener.legacy ? `legacy ${listener.processing}` : `listener ${listener.id}`
}

/**
 * Moves a listener's cloud text start up to `watermark`, never back before
 * where it already starts (its registration, or an earlier handoff). A
 * watermark in a session the listener never saw predates it.
 */
function advanceCutoff(listener: Listener, watermark: AudioPosition): void {
  const cutoff = listener.cutoff
  if (cutoff?.sessionTag === watermark.sessionTag) {
    if (watermark.offsetMs > cutoff.offsetMs) listener.cutoff = watermark
    return
  }
  if (!listener.sessions.has(watermark.sessionTag)) return
  listener.cutoff = watermark
  listener.sessions = new Set([watermark.sessionTag])
}

function projectTokens(listener: Listener, tokens: TranscriptionToken[]): string {
  return tokens
    .filter((token) => {
      const position = token.audioPosition
      if (!position) return false
      if (position.sessionTag === listener.cutoff?.sessionTag) return position.offsetMs >= listener.cutoff.offsetMs
      return listener.sessions.has(position.sessionTag)
    })
    .map((token) => token.text)
    .join("")
    .trim()
}
