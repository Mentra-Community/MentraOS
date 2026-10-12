import type {AudioPosition, TranscriptionToken} from "@mentra/cloud-protocol"

export interface TranscriptionListenerRegistration {
  id: string
  stream: string
  forceLocal?: boolean
  legacy?: boolean
}

interface Listener extends TranscriptionListenerRegistration {
  cutoff: AudioPosition | null
  sessions: Set<number>
}

/** Runtime-owned text projection. Token detail never crosses the miniapp bridge. */
export class TranscriptionSubscriptions {
  private listeners = new Map<string, Listener>()

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
        existing?.stream === registration.stream && !!existing.forceLocal === !!registration.forceLocal
          ? existing
          : {...registration, cutoff, sessions: new Set(cutoff ? [cutoff.sessionTag] : [])},
      )
    }
    this.listeners = next
  }

  project(
    stream: string,
    tokens: TranscriptionToken[],
    current: AudioPosition | null,
    route: "default" | "forceLocal" | "all",
  ) {
    this.observe(current)
    const events: Array<{listenerId?: string; text: string}> = []
    for (const listener of this.listeners.values()) {
      if (listener.stream !== stream && listener.stream !== "transcription:auto") continue
      if (listener.forceLocal ? route !== "forceLocal" && route !== "all" : route === "forceLocal") continue
      const eligible = tokens.filter((token) => {
        const position = token.audioPosition
        if (!position) return false
        if (position.sessionTag === listener.cutoff?.sessionTag) return position.offsetMs >= listener.cutoff.offsetMs
        return listener.sessions.has(position.sessionTag)
      })
      const text = eligible
        .map((token) => token.text)
        .join("")
        .trim()
      if (text && listener.legacy) {
        const existing = events.find((event) => event.listenerId === undefined)
        if (!existing) events.push({text})
        else if (text.length > existing.text.length) existing.text = text
      } else if (text) events.push({listenerId: listener.id, text})
    }
    return events
  }
}
