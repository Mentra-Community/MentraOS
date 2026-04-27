import {useEffect, useRef, useState} from "react"
import {useSession} from "@mentra/miniapp/react"
import type {HeadingData, LocationData, NavManeuver, NavRoute, NavUpdate} from "@mentra/miniapp"

import {NavMap} from "./NavMap"
import {OrientationCard} from "./OrientationCard"

// Default test destination. Replace with whatever you want to test.
const DEFAULTS = {lat: "37.768849", lng: "-122.422503"}

type LogEntry = {ts: number; line: string}
type Coords = {lat: number; lng: number; accuracy?: number; ts: number}

export default function App() {
  const session = useSession()
  const [lat, setLat] = useState(DEFAULTS.lat)
  const [lng, setLng] = useState(DEFAULTS.lng)
  const [running, setRunning] = useState(false)
  const [coords, setCoords] = useState<Coords | null>(null)
  const [maneuver, setManeuver] = useState<NavManeuver | null>(null)
  const [status, setStatus] = useState<"idle" | "navigating" | "rerouting" | "arrived">("idle")
  const [log, setLog] = useState<LogEntry[]>([])
  const [activeDestination, setActiveDestination] = useState<{lat: number; lng: number} | null>(null)
  const [routePoints, setRoutePoints] = useState<NavRoute["points"] | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{lat: number; lng: number}>>([])
  const [simulate, setSimulate] = useState(true)
  const [speedMultiplier, setSpeedMultiplier] = useState(5)
  const [heading, setHeading] = useState<number | null>(null)
  const navUnsubRef = useRef<(() => void) | null>(null)
  const routeUnsubRef = useRef<(() => void) | null>(null)

  // Live location stream — independent of nav. Subscribes for the lifetime
  // of the mini app so the "My location" card always reflects current GPS.
  useEffect(() => {
    const unsub = session.events.onLocation((d: LocationData) => {
      setCoords({lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()})
    })
    return unsub
  }, [session])

  // Live compass — used by OrientationCard to tell the user if they're
  // physically facing the right way for the current segment.
  useEffect(() => {
    const unsub = session.events.onHeading((d: HeadingData) => {
      setHeading(d.degrees)
    })
    return unsub
  }, [session])

  // While a trip is active, drop breadcrumb dots showing where we've been.
  // Only sample if we've moved at least ~3m since the last crumb.
  useEffect(() => {
    if (!running || !coords) return
    setBreadcrumbs((prev) => {
      const last = prev[prev.length - 1]
      if (last) {
        const dLat = (coords.lat - last.lat) * 111_320
        const dLng = (coords.lng - last.lng) * 111_320 * Math.cos((coords.lat * Math.PI) / 180)
        const meters = Math.sqrt(dLat * dLat + dLng * dLng)
        if (meters < 3) return prev
      }
      const next = [...prev, {lat: coords.lat, lng: coords.lng}]
      // Cap memory — most recent 500 crumbs is plenty for the trips we test
      return next.length > 500 ? next.slice(-500) : next
    })
  }, [running, coords?.lat, coords?.lng])

  useEffect(() => {
    return () => {
      navUnsubRef.current?.()
      navUnsubRef.current = null
      routeUnsubRef.current?.()
      routeUnsubRef.current = null
    }
  }, [])

  function append(line: string) {
    setLog((prev) => [{ts: Date.now(), line}, ...prev].slice(0, 100))
  }

  async function start() {
    const latNum = Number(lat)
    const lngNum = Number(lng)
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      append("ERROR: lat/lng must be numbers")
      return
    }
    setLog([])
    setManeuver(null)
    setStatus("navigating")
    setActiveDestination({lat: latNum, lng: lngNum})
    setRoutePoints(null)
    setBreadcrumbs([])
    append(`start → ${latNum}, ${lngNum}${simulate ? ` (sim ${speedMultiplier}x)` : ""}`)

    console.log("[NAV-MINI] start tapped", {latNum, lngNum})

    if (!navUnsubRef.current) {
      navUnsubRef.current = session.navigation.onUpdate((u: NavUpdate) => {
        console.log("[NAV-MINI] ← update", u)
        handleUpdate(u)
      })
    }
    if (!routeUnsubRef.current) {
      routeUnsubRef.current = session.navigation.onRoute((route: NavRoute) => {
        console.log("[NAV-MINI] ← route", route.points.length, "pts")
        setRoutePoints(route.points)
        append(`route: ${route.points.length} points`)
      })
    }

    console.log("[NAV-MINI] calling session.navigation.start()", {simulate, speedMultiplier})
    const result = await session.navigation.start({
      lat: latNum,
      lng: lngNum,
      simulate,
      speedMultiplier,
    })
    console.log("[NAV-MINI] start ack:", result)
    append(`start ack: ${JSON.stringify(result)}`)
    if (result.ok) {
      setRunning(true)
    } else {
      setStatus("idle")
      setActiveDestination(null)
      setRoutePoints(null)
      setBreadcrumbs([])
      navUnsubRef.current?.()
      navUnsubRef.current = null
      routeUnsubRef.current?.()
      routeUnsubRef.current = null
    }
  }

  async function stop() {
    const result = await session.navigation.stop()
    append(`stop ack: ${JSON.stringify(result)}`)
    navUnsubRef.current?.()
    navUnsubRef.current = null
    routeUnsubRef.current?.()
    routeUnsubRef.current = null
    setRunning(false)
    setStatus("idle")
    setManeuver(null)
    setActiveDestination(null)
    setRoutePoints(null)
    setBreadcrumbs([])
  }

  function handleUpdate(u: NavUpdate) {
    append(formatUpdate(u))
    switch (u.kind) {
      case "maneuver":
        setManeuver(u)
        setStatus("navigating")
        break
      case "rerouting":
        setStatus("rerouting")
        break
      case "arrived":
        setStatus("arrived")
        setManeuver(null)
        setRunning(false)
        setActiveDestination(null)
        setRoutePoints(null)
        setBreadcrumbs([])
        navUnsubRef.current?.()
        navUnsubRef.current = null
        routeUnsubRef.current?.()
        routeUnsubRef.current = null
        break
      case "error":
        setStatus("idle")
        break
    }
  }

  return (
    <div style={styles.page}>
      <h1 style={styles.h1}>Navigation</h1>

      {/* My location — live from session.events.onLocation */}
      <div style={styles.card}>
        <div style={styles.cardLabel}>📍 My location</div>
        {coords ? (
          <>
            <div style={styles.coordsLine}>
              {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
            </div>
            <div style={styles.coordsMeta}>
              {coords.accuracy != null ? `±${Math.round(coords.accuracy)}m • ` : ""}
              updated {timeAgo(coords.ts)}
            </div>
          </>
        ) : (
          <div style={styles.empty}>(waiting for fix…)</div>
        )}
      </div>

      {running ? (
        <OrientationCard
          me={coords ? {lat: coords.lat, lng: coords.lng} : null}
          heading={heading}
          maneuver={maneuver}
          routePoints={routePoints}
        />
      ) : null}

      <div style={{marginBottom: 12}}>
        <NavMap
          me={coords ? {lat: coords.lat, lng: coords.lng} : null}
          destination={activeDestination}
          routePoints={routePoints}
          breadcrumbs={breadcrumbs}
        />
      </div>

      <div style={styles.row}>
        <label style={styles.label}>
          Lat
          <input
            style={styles.input}
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            disabled={running}
            inputMode="decimal"
          />
        </label>
        <label style={styles.label}>
          Lng
          <input
            style={styles.input}
            value={lng}
            onChange={(e) => setLng(e.target.value)}
            disabled={running}
            inputMode="decimal"
          />
        </label>
      </div>

      <div style={styles.simRow}>
        <label style={styles.simLabel}>
          <input
            type="checkbox"
            checked={simulate}
            onChange={(e) => setSimulate(e.target.checked)}
            disabled={running}
          />
          <span>Simulate walking</span>
        </label>
        {simulate ? (
          <label style={styles.speedLabel}>
            <span style={styles.speedValue}>{speedMultiplier}x</span>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={speedMultiplier}
              onChange={(e) => setSpeedMultiplier(Number(e.target.value))}
              disabled={running}
              style={styles.slider}
            />
          </label>
        ) : null}
      </div>

      <div style={styles.btnRow}>
        {!running ? (
          <button style={styles.startBtn} onClick={start}>
            Start{simulate ? ` (sim ${speedMultiplier}x)` : ""}
          </button>
        ) : (
          <button style={styles.stopBtn} onClick={stop}>
            Stop
          </button>
        )}
      </div>

      {/* Status + active maneuver — the big read-out */}
      {running || maneuver || status !== "idle" ? (
        <>
          <div style={styles.statusRow}>
            <div style={styles.statusPill(status)}>{statusText(status)}</div>
            {maneuver && maneuver.distanceMeters >= 0 ? (
              <div style={styles.distanceBadge}>{formatDistance(maneuver.distanceMeters)}</div>
            ) : null}
          </div>

          {maneuver ? (
            <ManeuverPill
              glyph={maneuverGlyph(maneuver.maneuverType)}
              primary={maneuverHeadline(maneuver)}
            />
          ) : (
            <div style={styles.empty}>
              {status === "rerouting" ? "Rebuilding route…" : "Waiting for first maneuver…"}
            </div>
          )}
        </>
      ) : null}

      <h2 style={styles.h2}>
        Live updates {running ? "•" : ""} <span style={styles.count}>({log.length})</span>
      </h2>
      <div style={styles.log}>
        {log.length === 0 ? (
          <div style={styles.empty}>(no events yet)</div>
        ) : (
          log.map((e) => (
            <div key={e.ts + e.line} style={styles.logLine}>
              <span style={styles.logTs}>{new Date(e.ts).toLocaleTimeString()}</span>
              <span>{e.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function formatUpdate(u: NavUpdate): string {
  switch (u.kind) {
    case "maneuver":
      return `MANEUVER: ${u.maneuverType} in ${u.distanceMeters}m`
    case "rerouting":
      return "REROUTING"
    case "arrived":
      return "ARRIVED"
    case "error":
      return `ERROR: ${u.message}`
    default:
      return JSON.stringify(u)
  }
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`
}

function maneuverGlyph(type: string): string {
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
    default:
      return "↑"
  }
}

/** Human-readable verb for a categorical maneuver type. */
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
    case "U_TURN":
      return "make a U-turn"
    case "STRAIGHT":
    case "CONTINUE":
      return "continue straight"
    case "ARRIVE":
      return "arrive"
    default:
      return type.toLowerCase().replace(/_/g, " ")
  }
}

/**
 * One-line headline for the maneuver pill. Built purely from the
 * categorical type + distance — no road names.
 *
 *   "In 200 m, turn right"
 *   "Sharp left in 50 m"
 *   "Continue straight"
 *   "Arriving in 35 m"
 */
function maneuverHeadline(m: NavManeuver): string {
  const verb = humanManeuver(m.maneuverType)
  if (m.maneuverType === "ARRIVE") {
    return m.distanceMeters > 0 ? `Arriving in ${formatDistance(m.distanceMeters)}` : "Arriving"
  }
  if (m.maneuverType === "STRAIGHT") {
    return "Continue straight"
  }
  if (m.distanceMeters > 0) {
    return `In ${formatDistance(m.distanceMeters)}, ${verb}`
  }
  return verb.charAt(0).toUpperCase() + verb.slice(1)
}

function ManeuverPill({glyph, primary}: {glyph: string; primary: string}) {
  return (
    <div style={styles.pill}>
      <div style={styles.pillGlyph}>{glyph}</div>
      <div style={styles.pillText}>
        <div style={styles.pillPrimary}>{primary}</div>
      </div>
    </div>
  )
}

function statusText(s: "idle" | "navigating" | "rerouting" | "arrived"): string {
  switch (s) {
    case "idle":
      return "IDLE"
    case "navigating":
      return "NAVIGATING"
    case "rerouting":
      return "REROUTING"
    case "arrived":
      return "ARRIVED"
  }
}

function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 2) return "just now"
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

const styles = {
  page: {padding: 16, fontFamily: "system-ui, sans-serif", color: "#111"} as React.CSSProperties,
  h1: {fontSize: 22, margin: "0 0 12px"} as React.CSSProperties,
  h2: {fontSize: 14, margin: "20px 0 8px", color: "#444"} as React.CSSProperties,
  count: {color: "#999", fontWeight: "normal"} as React.CSSProperties,
  card: {
    border: "1px solid #e6e6e6",
    background: "#f7f9fb",
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  } as React.CSSProperties,
  cardLabel: {fontSize: 11, color: "#666", marginBottom: 4, textTransform: "uppercase" as const, letterSpacing: 0.5},
  coordsLine: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 14,
  } as React.CSSProperties,
  coordsMeta: {fontSize: 11, color: "#666", marginTop: 2} as React.CSSProperties,
  row: {display: "flex", gap: 12, marginBottom: 12} as React.CSSProperties,
  label: {flex: 1, display: "flex", flexDirection: "column" as const, fontSize: 12, color: "#555"},
  input: {
    fontSize: 16,
    padding: "8px 10px",
    border: "1px solid #ccc",
    borderRadius: 8,
    marginTop: 4,
  } as React.CSSProperties,
  simRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
    padding: "8px 10px",
    background: "#fff8e1",
    border: "1px solid #f0d97c",
    borderRadius: 8,
  } as React.CSSProperties,
  simLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "#6b5300",
    cursor: "pointer",
    flexShrink: 0,
  } as React.CSSProperties,
  speedLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flex: 1,
    fontSize: 12,
    color: "#6b5300",
  } as React.CSSProperties,
  speedValue: {
    fontFamily: "ui-monospace, monospace",
    fontWeight: 700,
    minWidth: 28,
    textAlign: "right",
  } as React.CSSProperties,
  slider: {flex: 1, accentColor: "#c89a00"} as React.CSSProperties,
  btnRow: {display: "flex", gap: 8} as React.CSSProperties,
  startBtn: {
    flex: 1,
    background: "#0a84ff",
    color: "white",
    border: "none",
    padding: "12px 16px",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
  } as React.CSSProperties,
  stopBtn: {
    flex: 1,
    background: "#ff3b30",
    color: "white",
    border: "none",
    padding: "12px 16px",
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 600,
  } as React.CSSProperties,
  statusRow: {
    marginTop: 16,
    marginBottom: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  } as React.CSSProperties,
  statusPill: (s: "idle" | "navigating" | "rerouting" | "arrived"): React.CSSProperties => ({
    display: "inline-block",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    padding: "3px 8px",
    borderRadius: 999,
    background: s === "rerouting" ? "#ffd84a" : s === "arrived" ? "#34c759" : s === "navigating" ? "#0a84ff" : "#999",
    color: s === "rerouting" ? "#5a4500" : "white",
  }),
  distanceBadge: {
    fontSize: 16,
    fontWeight: 700,
    color: "#2c5f3f",
    background: "#eaf5ef",
    border: "1px solid #cbe4d6",
    borderRadius: 8,
    padding: "3px 10px",
  } as React.CSSProperties,

  // Big green pill — the current maneuver read-out
  pill: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    background: "#2e7d5b",
    color: "white",
    borderRadius: 20,
    padding: "18px 22px",
    boxShadow: "0 2px 10px rgba(46,125,91,0.25)",
  } as React.CSSProperties,
  pillGlyph: {
    fontSize: 44,
    fontWeight: 700,
    lineHeight: 1,
    flexShrink: 0,
    minWidth: 44,
    textAlign: "center",
  } as React.CSSProperties,
  pillText: {flex: 1, minWidth: 0} as React.CSSProperties,
  pillPrimary: {
    fontSize: 30,
    fontWeight: 600,
    lineHeight: 1.1,
    letterSpacing: -0.3,
    wordBreak: "break-word",
  } as React.CSSProperties,
  pillPrimarySuffix: {fontSize: 18, fontWeight: 400, opacity: 0.85} as React.CSSProperties,
  pillSecondary: {
    fontSize: 16,
    marginTop: 4,
    opacity: 0.85,
    wordBreak: "break-word",
  } as React.CSSProperties,
  pillSecondaryBold: {fontSize: 20, fontWeight: 600, opacity: 1} as React.CSSProperties,
  pillSecondarySuffix: {fontSize: 13, fontWeight: 400, opacity: 0.75} as React.CSSProperties,

  // Stacked "Then →" chip below the main pill
  thenChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "#2e7d5b",
    color: "white",
    borderRadius: 14,
    padding: "8px 14px",
    marginTop: -6,
    marginLeft: 6,
    fontSize: 18,
    fontWeight: 500,
  } as React.CSSProperties,
  thenChipLabel: {fontWeight: 500} as React.CSSProperties,
  thenChipGlyph: {fontSize: 22, fontWeight: 700, lineHeight: 1} as React.CSSProperties,
  log: {
    border: "1px solid #eee",
    borderRadius: 8,
    padding: 8,
    maxHeight: 360,
    overflowY: "auto" as const,
    background: "#fafafa",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
  },
  logLine: {
    padding: "4px 6px",
    borderBottom: "1px solid #f0f0f0",
    display: "flex",
    gap: 8,
  } as React.CSSProperties,
  logTs: {color: "#999", flexShrink: 0} as React.CSSProperties,
  empty: {color: "#999", padding: 8} as React.CSSProperties,
}
