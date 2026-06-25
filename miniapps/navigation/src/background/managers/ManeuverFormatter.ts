/**
 * ManeuverFormatter
 *
 * Pure presentation helpers for `NavManeuver` data — glyphs, arrows,
 * human verbs, headlines, and the glasses NOW/NEXT line pair. Lives
 * under `user.navigation.format` so anything maneuver-related has a
 * single entry point.
 *
 * Stateless: every method is a pure function of its inputs. The class
 * shape exists only so callers can reach the helpers via the
 * NavigationManager (`user.navigation.format.headline(m)`).
 */

import type {NavManeuver} from "@mentra/miniapp"

import type {UnitSystem} from "../../shared/types"
import {formatDistance, formatDuration} from "../lib/formatDistance"

/** Distance threshold below which a turn becomes the active instruction. */
const IMMINENT_M = 30

export class ManeuverFormatter {
  /** A "go straight" continuation rather than a turn. */
  isStraight(m: NavManeuver | null): boolean {
    return !!m && (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE")
  }

  /** Capitalize first letter. */
  cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1)
  }

  /** Big glyph for the OrientationCard / pill. */
  glyph(type: string): string {
    switch (type.toUpperCase()) {
      case "TURN_LEFT":
        return "↰"
      case "TURN_RIGHT":
        return "↱"
      case "SLIGHT_LEFT":
        return "↖"
      case "SLIGHT_RIGHT":
        return "↗"
      case "SHARP_LEFT":
        return "⤴"
      case "SHARP_RIGHT":
        return "⤵"
      case "U_TURN":
        return "↶"
      case "STRAIGHT":
      case "CONTINUE":
        return "↑"
      case "ARRIVE":
        return "●"
      case "CROSS_STREET":
        return "⇆"
      default:
        return "↑"
    }
  }

  /** Compact arrow for short text lines (←/→/↑). */
  arrow(type: string): string {
    const t = type.toUpperCase()
    if (t === "CROSS_STREET") return "⇆"
    if (t.includes("LEFT")) return "←"
    if (t.includes("RIGHT")) return "→"
    if (t === "U_TURN") return "↺"
    return "↑"
  }

  /** Human-readable verb. */
  humanize(type: string): string {
    switch (type.toUpperCase()) {
      case "TURN_LEFT":
        return "turn left"
      case "TURN_RIGHT":
        return "turn right"
      case "SLIGHT_LEFT":
        return "slight left"
      case "SLIGHT_RIGHT":
        return "slight right"
      case "SHARP_LEFT":
        return "sharp left"
      case "SHARP_RIGHT":
        return "sharp right"
      case "U_TURN":
        return "turn around"
      case "STRAIGHT":
      case "CONTINUE":
        return "continue straight"
      case "ARRIVE":
        return "arrive"
      case "CROSS_STREET":
        return "cross the road"
      default:
        return type.toLowerCase().replace(/_/g, " ")
    }
  }

  /**
   * One-line headline for the maneuver pill. Built from the categorical
   * type + distance — no road names.
   *
   *   "In 200 m, turn right"
   *   "Continue straight"
   *   "Arriving in 35 m"
   */
  headline(m: NavManeuver, unit: UnitSystem = "metric"): string {
    const verb = this.humanize(m.maneuverType)
    if (m.maneuverType === "ARRIVE") {
      return m.distanceMeters > 0 ? `Arriving in ${formatDistance(m.distanceMeters, unit)}` : "Arriving"
    }
    if (m.maneuverType === "STRAIGHT") {
      return "Continue straight"
    }
    if (m.distanceMeters > 0) {
      return `In ${formatDistance(m.distanceMeters, unit)}, ${verb}`
    }
    return this.cap(verb)
  }

  /**
   * Two short lines for the glasses HUD — NOW (top) + NEXT (bottom).
   * Returns `next: null` when the imminent turn IS the active instruction
   * (≤ IMMINENT_M), in which case the caller falls back to a single line.
   */
  glassesLines(m: NavManeuver, unit: UnitSystem = "metric"): {now: string; next: string | null} {
    const dist = m.distanceMeters
    const isStraightT = this.isStraight(m)
    const arrowed = (verb: string) => `${this.arrow(m.maneuverType)} ${verb}`
    const toRoad = this.cleanRoad(m.toRoad, m.maneuverType)

    if (!isStraightT && dist >= 0 && dist <= IMMINENT_M) {
      const verb = this.humanize(m.maneuverType)
      // CROSS_STREET keeps the same road on both sides — never append
      // "onto X". The verb already reads as a complete instruction.
      const onto = m.maneuverType === "CROSS_STREET" || !toRoad ? "" : ` onto ${toRoad}`
      return {now: arrowed(`${this.cap(verb)}${onto}`), next: null}
    }

    const road = this.cleanRoad(m.fromRoad, m.maneuverType)
    const distStr = dist > 0 ? formatDistance(dist, unit) : null
    const nowLine =
      road && distStr
        ? `↑ ${road} • ${distStr}`
        : road
          ? `↑ ${road}`
          : distStr
            ? `↑ Continue ${distStr}`
            : "↑ Continue"

    if (isStraightT) {
      return {now: nowLine, next: null}
    }
    const verb = this.humanize(m.maneuverType)
    const onto = m.maneuverType === "CROSS_STREET" || !toRoad ? "" : ` onto ${toRoad}`
    return {now: nowLine, next: arrowed(`Then ${verb}${onto}`)}
  }

  /**
   * Third HUD line: "1.2 km to destination · 14 min". Returns null when
   * the engine hasn't supplied trip totals yet (-1 sentinels), so the UI
   * can hide the line instead of rendering em-dashes.
   */
  glassesProgressLine(m: NavManeuver, unit: UnitSystem = "metric"): string | null {
    const dist = m.distanceToDestinationMeters
    const time = m.timeToDestinationSeconds
    const haveDist = typeof dist === "number" && dist >= 0
    const haveTime = typeof time === "number" && time >= 0
    if (!haveDist && !haveTime) return null
    const distStr = haveDist ? `${formatDistance(dist!, unit)} to destination` : null
    const timeStr = haveTime ? formatDuration(time!) : null
    return [distStr, timeStr].filter(Boolean).join(" · ")
  }

  /**
   * Drop a "road name" that's actually the maneuver instruction. The
   * Google Nav SDK falls back to its instruction text (e.g. "Turn left")
   * when the underlying road has no name, and that bubbles all the way
   * here — concatenated naively, you'd render "Turn left onto Turn left".
   * Returns null when the road string is empty or duplicates the verb.
   */
  private cleanRoad(road: string | null | undefined, maneuverType: string): string | null {
    const trimmed = road?.trim()
    if (!trimmed) return null
    const verb = this.humanize(maneuverType).toLowerCase()
    const lower = trimmed.toLowerCase()
    if (lower === verb || lower.startsWith(verb)) return null
    return trimmed
  }
}
