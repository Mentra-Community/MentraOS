/**
 * @fileoverview TelemetryModule (`session.telemetry`): a miniapp's own analytics, shown in its organization's Fleet
 * Management.
 *
 * `capture(event, properties?)` sends one fire-and-forget message to the Mentra App and returns nothing. It never throws
 * and never waits. The SDK checks nothing: the Mentra App attributes the event to this miniapp and applies the limits
 * (names, values, 25 properties, the rate), and on a Mentra App without the `telemetry` host feature it does nothing.
 * Before the handshake says which, it holds the latest 100 captures and sends them once it knows.
 */

import {MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"

export type TelemetryValue = string | number | boolean
export type TelemetryProperties = Record<string, TelemetryValue>

/** Captures held until the handshake says whether the Mentra App takes them. */
const MAX_HELD = 100

export class TelemetryModule {
  private held: object[] = []
  private waiting = false

  constructor(private readonly session: MiniappSession) {}

  /**
   * Captures one event, in the style of PostHog: `session.telemetry.capture("call_ended", {platform: "teams",
   * duration_s: 312})`. Names are lowercase letters, digits and underscores; values are flat. Never personal data: no
   * names, emails, phone numbers, typed text or content.
   */
  capture(event: string, properties?: TelemetryProperties): void {
    try {
      const message = {type: MiniappRequestType.TELEMETRY_CAPTURE, event, properties: properties ?? {}}
      if (this.session.handshakeDone) {
        if (this.session.hostFeatures?.telemetry === true) this.session.sendOneShot(message)
        return
      }
      if (this.held.length >= MAX_HELD) this.held.shift()
      this.held.push(message)
      if (!this.waiting) {
        this.waiting = true
        const off = this.session.on("ready", () => {
          off()
          this.waiting = false
          const held = this.held.splice(0)
          if (this.session.hostFeatures?.telemetry !== true) return
          for (const one of held) {
            // Each on its own: one capture that cannot be sent never takes the others, or the session's other
            // listeners, down with it.
            try {
              this.session.sendOneShot(one)
            } catch {
              // Lost.
            }
          }
        })
      }
    } catch {
      // Analytics never break the miniapp: a value that cannot be sent is lost.
    }
  }
}
