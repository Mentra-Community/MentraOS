import type {NavManeuver} from "@mentra/miniapp"

type LatLng = {lat: number; lng: number}

/**
 * OrientationCard
 *
 * Sits between the green maneuver pill and the map. Two pieces of info:
 *
 *  1. A soft hint when the phone is pointed wrong relative to the route's
 *     current direction of travel. Active only when the heading is off
 *     by more than ~30°. Never overrides the maneuver pill — the user's
 *     real instruction stays the same; this just helps them physically
 *     orient.
 *
 *  2. A "next" line: distance + categorical maneuver + road name for the
 *     upcoming turn. On the final segment (no upcoming turn) it switches
 *     to "Arriving in Xm at destination".
 */
export function OrientationCard({
  me,
  heading,
  maneuver,
  routePoints,
}: {
  me: LatLng | null
  heading: number | null
  maneuver: NavManeuver | null
  routePoints: LatLng[] | null
}) {
  const segmentBearing = nextSegmentBearing(me, routePoints)
  const headingOffset =
    heading != null && segmentBearing != null ? signedAngleDiff(segmentBearing, heading) : null

  // Severity: > 90° = "behind you", > 30° = "off-axis"
  const offAxis = headingOffset != null ? Math.abs(headingOffset) > 30 : false
  const reversed = headingOffset != null ? Math.abs(headingOffset) > 90 : false

  return (
    <div style={styles.card}>
      {/* Top row — orientation hint */}
      <div style={styles.row}>
        <div style={styles.iconBox}>
          {headingOffset == null ? (
            <span style={styles.iconNeutral}>•</span>
          ) : reversed ? (
            <span style={styles.iconWarn}>↻</span>
          ) : offAxis ? (
            <span style={styles.iconHint}>{headingOffset < 0 ? "↺" : "↻"}</span>
          ) : (
            <span style={styles.iconOk}>↑</span>
          )}
        </div>
        <div style={styles.rowText}>
          <div style={styles.rowPrimary}>
            {headingOffset == null
              ? "Hold the phone level to orient"
              : reversed
              ? "You're facing away from the route — turn around"
              : offAxis
              ? `Slight ${headingOffset < 0 ? "left" : "right"} — face along the route`
              : "You're aimed correctly"}
          </div>
          {headingOffset != null ? (
            <div style={styles.rowMeta}>
              {Math.abs(Math.round(headingOffset))}° off the route
            </div>
          ) : null}
        </div>
      </div>

      {/* Divider */}
      <div style={styles.divider} />

      {/* NOW — what to do right this moment */}
      <div style={styles.stepRow}>
        <span style={styles.glyphNow}>{nowGlyph(maneuver)}</span>
        <div style={styles.stepText}>
          <div style={styles.stepLabelNow}>NOW</div>
          <div style={styles.stepPrimary}>{formatNow(maneuver)}</div>
        </div>
      </div>

      {/* NEXT — the upcoming turn (hidden when NOW already is the turn) */}
      {showNext(maneuver) ? (
        <>
          <div style={styles.dividerThin} />
          <div style={styles.stepRow}>
            <span style={styles.glyphNext}>{nextGlyph(maneuver)}</span>
            <div style={styles.stepText}>
              <div style={styles.stepLabelNext}>NEXT</div>
              <div style={styles.stepSecondary}>{formatNext(maneuver)}</div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** Distance below which the upcoming turn IS the active instruction. */
const IMMINENT_M = 30

/** True iff the maneuver represents a "go straight" continuation. */
function isStraight(m: NavManeuver | null): boolean {
  return !!m && (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE")
}

/** Whether to render the secondary NEXT row. */
function showNext(m: NavManeuver | null): m is NavManeuver {
  if (!m) return false
  if (m.maneuverType === "ARRIVE") return false
  // When the turn is imminent, NOW already shows the turn — no need for NEXT.
  if (!isStraight(m) && m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M) return false
  return true
}

function formatNow(m: NavManeuver | null): string {
  if (!m) return "Waiting for route…"
  if (m.maneuverType === "ARRIVE") {
    return m.distanceMeters > 0 ? `Arriving in ${formatDistance(m.distanceMeters)}` : "Arriving"
  }
  // Imminent turn — promote it to the NOW slot.
  if (m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M && !isStraight(m)) {
    const verb = humanManeuver(m.maneuverType)
    const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
    return `${cap(verb)}${onto}`
  }
  // Otherwise we're on a straightaway — describe the current segment.
  const road = m.fromRoad?.trim()
  const dist = m.distanceMeters > 0 ? formatDistance(m.distanceMeters) : null
  if (road && dist) return `Continue on ${road} for ${dist}`
  if (road) return `Continue on ${road}`
  if (dist) return `Continue straight for ${dist}`
  return "Continue straight"
}

function formatNext(m: NavManeuver): string {
  const verb = humanManeuver(m.maneuverType)
  const onto = m.toRoad ? ` onto ${m.toRoad}` : ""
  if (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE") {
    return m.toRoad ? `Continue onto ${m.toRoad}` : "Continue straight"
  }
  return `${cap(verb)}${onto}`
}

function nowGlyph(m: NavManeuver | null): string {
  if (!m) return "•"
  if (m.maneuverType === "ARRIVE") return "📍"
  if (m.distanceMeters >= 0 && m.distanceMeters <= IMMINENT_M && !isStraight(m)) {
    return arrowFor(m.maneuverType)
  }
  return "↑"
}

function nextGlyph(m: NavManeuver): string {
  if (m.maneuverType === "ARRIVE") return "📍"
  return arrowFor(m.maneuverType)
}

function arrowFor(type: string): string {
  switch (type.toUpperCase()) {
    case "TURN_LEFT":
    case "SLIGHT_LEFT":
    case "SHARP_LEFT":
      return "←"
    case "TURN_RIGHT":
    case "SLIGHT_RIGHT":
    case "SHARP_RIGHT":
      return "→"
    case "U_TURN":
      return "↺"
    default:
      return "↑"
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/* -------------------------------------------------------------------------- */

function formatDistance(m: number): string {
  if (m < 0) return "—"
  if (m < 1000) return `${m} m`
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
}

function humanManeuver(type: string): string {
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
    case "STRAIGHT":
    case "CONTINUE":
      return "continue straight"
    case "U_TURN":
      return "make a U-turn"
    case "ARRIVE":
      return "arrive"
    default:
      return type.toLowerCase().replace(/_/g, " ")
  }
}

/**
 * Bearing of the route at the user's current position. We find the
 * polyline segment closest to `me` and use its endpoint bearing — this
 * tells us which way the route wants you to face right now.
 */
function nextSegmentBearing(me: LatLng | null, route: LatLng[] | null): number | null {
  if (!me || !route || route.length < 2) return null
  // Find segment with minimum perpendicular distance to `me`.
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const d = perpDistanceMeters(me, route[i], route[i + 1])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bearingDeg(route[bestIdx], route[bestIdx + 1])
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Smallest signed difference: target - actual, in [-180, 180]. */
function signedAngleDiff(target: number, actual: number): number {
  let d = ((target - actual + 540) % 360) - 180
  return d
}

/**
 * Approximate perpendicular distance from p to segment a→b, in meters.
 * Good enough for picking the closest segment of a polyline.
 */
function perpDistanceMeters(p: LatLng, a: LatLng, b: LatLng): number {
  // Convert to a local meter-ish frame around `a`. Small-angle math is
  // fine for the segment lengths we care about (10s–100s of meters).
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((a.lat * Math.PI) / 180)
  const ax = 0
  const ay = 0
  const bx = (b.lng - a.lng) * mPerDegLng
  const by = (b.lat - a.lat) * mPerDegLat
  const px = (p.lng - a.lng) * mPerDegLng
  const py = (p.lat - a.lat) * mPerDegLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.sqrt(px * px + py * py)
  let t = (px * dx + py * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const projx = ax + t * dx
  const projy = ay + t * dy
  return Math.sqrt((px - projx) * (px - projx) + (py - projy) * (py - projy))
}

const styles = {
  card: {
    marginTop: 12,
    marginBottom: 12,
    padding: 12,
    border: "1px solid #d6e4f0",
    background: "#f4f8fc",
    borderRadius: 12,
  } as React.CSSProperties,
  row: {display: "flex", alignItems: "center", gap: 12} as React.CSSProperties,
  iconBox: {
    width: 38,
    height: 38,
    borderRadius: 999,
    background: "white",
    border: "1px solid #d6e4f0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  } as React.CSSProperties,
  iconNeutral: {fontSize: 18, color: "#aaa"} as React.CSSProperties,
  iconOk: {fontSize: 22, color: "#2e7d5b", fontWeight: 700} as React.CSSProperties,
  iconHint: {fontSize: 22, color: "#c89a00", fontWeight: 700} as React.CSSProperties,
  iconWarn: {fontSize: 22, color: "#c0392b", fontWeight: 700} as React.CSSProperties,
  rowText: {flex: 1, minWidth: 0} as React.CSSProperties,
  rowPrimary: {fontSize: 14, fontWeight: 600, color: "#222", lineHeight: 1.2} as React.CSSProperties,
  rowMeta: {fontSize: 11, color: "#777", marginTop: 2, fontFamily: "ui-monospace, monospace"} as React.CSSProperties,
  divider: {height: 1, background: "#dde7f2", margin: "10px 0"} as React.CSSProperties,
  dividerThin: {height: 1, background: "#e6eef7", margin: "8px 0"} as React.CSSProperties,
  nextRow: {fontSize: 14, color: "#333", lineHeight: 1.4} as React.CSSProperties,
  nextLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: "#1a73e8",
    letterSpacing: 0.6,
    background: "white",
    border: "1px solid #d6e4f0",
    borderRadius: 4,
    padding: "1px 5px",
    marginRight: 6,
  } as React.CSSProperties,
  nextText: {color: "#222"} as React.CSSProperties,

  // NOW / NEXT step rows
  stepRow: {display: "flex", alignItems: "center", gap: 12} as React.CSSProperties,
  glyphNow: {
    fontSize: 28,
    fontWeight: 700,
    color: "#1a73e8",
    width: 38,
    textAlign: "center",
    flexShrink: 0,
  } as React.CSSProperties,
  glyphNext: {
    fontSize: 22,
    fontWeight: 700,
    color: "#7a8aa1",
    width: 38,
    textAlign: "center",
    flexShrink: 0,
  } as React.CSSProperties,
  stepText: {flex: 1, minWidth: 0} as React.CSSProperties,
  stepLabelNow: {
    fontSize: 10,
    fontWeight: 700,
    color: "#1a73e8",
    letterSpacing: 0.8,
    marginBottom: 2,
  } as React.CSSProperties,
  stepLabelNext: {
    fontSize: 10,
    fontWeight: 700,
    color: "#7a8aa1",
    letterSpacing: 0.8,
    marginBottom: 2,
  } as React.CSSProperties,
  stepPrimary: {
    fontSize: 16,
    fontWeight: 600,
    color: "#222",
    lineHeight: 1.25,
  } as React.CSSProperties,
  stepSecondary: {
    fontSize: 14,
    fontWeight: 500,
    color: "#444",
    lineHeight: 1.25,
  } as React.CSSProperties,
}
