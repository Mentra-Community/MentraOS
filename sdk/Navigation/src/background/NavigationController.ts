/**
 * NavigationController — the always-on logic for the Mentra Map
 * miniapp. Owns MiniappSession subscriptions, trip state, the glasses
 * HUD logic, storage reads/writes, and Places REST. Lives for the
 * entire session — closing the WebView does NOT stop navigation.
 *
 * The UI WebView is a thin renderer fed via session.ui.send and the
 * UI's mentra.send / mentra.request bus declared in shared/channels.ts.
 */

import type {MiniappSession, NavRoute, NavUpdate, Pivot, UIModule} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {Coords, DevSettings, LogEntry, NavSnapshot, TripState} from "../shared/types"

import {CompassManager} from "./managers/CompassManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NavigationManager} from "./managers/NavigationManager"
import {PlacesManager} from "./managers/PlacesManager"
import {SimpleStorageManager} from "./managers/SimpleStorageManager"
import {formatDistance} from "./lib/formatDistance"
import {haversineMeters} from "./lib/geometry"

export class NavigationController {
  private readonly ui: UIModule<Channels>
  private readonly location: LocationManager
  private readonly compass: CompassManager
  private readonly display: DisplayManager
  private readonly navigation: NavigationManager
  private readonly storage: SimpleStorageManager
  private readonly places: PlacesManager

  private unsubs: Array<() => void> = []
  private started = false
  private logSeq = 0
  private lastHudKey = ""

  // Canonical state (mirrored to UI).
  private coords: Coords | null = null
  private heading: number | null = null
  private trip: TripState = {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    routeSteps: null,
    offRouteAt: null,
  }
  private activePivot: Pivot | null = null
  private upcomingPivot: Pivot | null = null
  private log: LogEntry[] = []
  private devSettings: DevSettings = {
    simulate: false,
    speedMultiplier: 5,
    wrongSidewalk: false,
    skipCrossings: false,
  }

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as UIModule<Channels>
    this.location = new LocationManager(session)
    this.compass = new CompassManager(session)
    this.display = new DisplayManager(session)
    this.navigation = new NavigationManager(session)
    this.storage = new SimpleStorageManager(session)
    this.places = new PlacesManager()
  }

  start(): void {
    if (this.started) return
    this.started = true

    this.wireSensorSubscriptions()
    this.wireRpcHandlers()
    this.wireUIBroadcasts()
    this.wireHUDPump()
    this.primeNavigationPermission()
    this.seedInitialFix()

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  // ── Sensor → state pump ──────────────────────────────────────────────

  private wireSensorSubscriptions(): void {
    // Location
    this.unsubs.push(
      this.location.onUpdate((d) => {
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now(),
        }
        this.ui.send("nav:coords", this.coords)
        this.refreshHUD()
      }),
    )

    // Heading — throttled to ~10Hz so we don't saturate the bus.
    const HEADING_MIN_INTERVAL_MS = 100
    let lastHeadingAt = 0
    let pendingHeading: number | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    const flushHeading = () => {
      pendingTimer = null
      if (pendingHeading == null) return
      this.heading = pendingHeading
      pendingHeading = null
      lastHeadingAt = Date.now()
      this.ui.send("nav:heading", {degrees: this.heading})
    }
    this.unsubs.push(
      this.compass.onUpdate((d) => {
        const now = Date.now()
        const elapsed = now - lastHeadingAt
        if (elapsed >= HEADING_MIN_INTERVAL_MS) {
          this.heading = d.degrees
          lastHeadingAt = now
          this.ui.send("nav:heading", {degrees: this.heading})
        } else {
          pendingHeading = d.degrees
          if (!pendingTimer) pendingTimer = setTimeout(flushHeading, HEADING_MIN_INTERVAL_MS - elapsed)
        }
      }),
    )
    this.unsubs.push(() => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      pendingHeading = null
    })

    // Pivot events
    this.unsubs.push(
      this.navigation.onPivot(() => {
        this.activePivot = this.navigation.getActivePivot()
        this.upcomingPivot = this.navigation.getUpcomingPivot()
        this.ui.send("nav:pivots", {
          active: this.activePivot,
          upcoming: this.upcomingPivot,
        })
        this.refreshHUD()
      }),
    )

    // Navigation updates (maneuver / off_route / rerouting / arrived / error)
    this.unsubs.push(
      this.navigation.onUpdate((u: NavUpdate) => {
        this.appendLog(this.formatUpdate(u))
        switch (u.kind) {
          case "maneuver":
            this.trip = {
              ...this.trip,
              status: "navigating",
              running: true,
              maneuver: u,
              offRouteAt: null,
            }
            break
          case "off_route":
            this.trip = {...this.trip, offRouteAt: Date.now()}
            break
          case "rerouting":
            this.trip = {...this.trip, status: "rerouting"}
            break
          case "arrived":
            this.trip = {
              ...this.trip,
              status: "arrived",
              running: false,
              maneuver: null,
              activeDestination: null,
              routePoints: null,
              routeSteps: null,
              offRouteAt: null,
            }
            break
          case "error":
            this.trip = {...this.trip, status: "idle", running: false}
            break
        }
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }),
    )

    // Route updates (full polyline rebuild)
    this.unsubs.push(
      this.navigation.onRoute((route: NavRoute) => {
        // Mirror NavStep → NavRouteStep, dropping `routeIndex` (UI
        // doesn't need it) and widening `maneuver` from the SDK union
        // to a plain string for the channel wire (see NavRouteStep).
        const steps =
          route.steps && route.steps.length > 0
            ? route.steps.map((s) => ({
                lat: s.lat,
                lng: s.lng,
                road: s.road ?? null,
                maneuver: s.maneuver,
                distanceMeters: s.distanceMeters,
              }))
            : null
        this.trip = {...this.trip, routePoints: route.points, routeSteps: steps}
        this.ui.send("nav:route", {points: route.points, steps})
        this.ui.send("nav:trip-state", this.trip)
        logLiveRoute(route)
        // Push the initial pivot snapshot. The SDK's onPivot only fires
        // on approaching/entered/exited transitions — at trip start the
        // user can be far from every pivot, so no transition has fired
        // yet and the UI would sit on stale (null, null) pivots until
        // the user got close. Pull the current pair off the engine and
        // ship it explicitly so the maneuver card has something to
        // render from the moment the trip begins.
        //
        // Race window: the SDK's NavigationModule subscribes the pivot
        // engine to the SAME onRoute event we're handling here. If the
        // engine subscribed AFTER us, getUpcomingPivot() runs before
        // the engine has built pivots from this route. Defer one
        // microtask + macrotask hop so every subscriber finishes
        // processing the event before we snapshot.
        setTimeout(() => {
          this.activePivot = this.navigation.getActivePivot()
          this.upcomingPivot = this.navigation.getUpcomingPivot()
          this.ui.send("nav:pivots", {active: this.activePivot, upcoming: this.upcomingPivot})
        }, 0)
      }),
    )
  }

  // ── RPC handlers ─────────────────────────────────────────────────────

  private wireRpcHandlers(): void {
    this.unsubs.push(this.ui.handle("nav:compute-route", (opts) => this.navigation.computeRoute(opts)))
    this.unsubs.push(this.ui.handle("nav:request-permission", () => this.navigation.requestPermission()))
    this.unsubs.push(this.ui.handle("nav:get-snapshot", () => this.buildSnapshot()))
    this.unsubs.push(this.ui.handle("nav:get-pivots", () => this.navigation.getPivots()))

    this.unsubs.push(
      this.ui.handle("places:autocomplete", ({query, near}, ctx) => this.places.autocomplete(query, near, ctx?.signal)),
    )
    this.unsubs.push(this.ui.handle("places:details", ({placeId}, ctx) => this.places.details(placeId, ctx?.signal)))

    this.unsubs.push(this.ui.handle("storage:list-saved", () => this.storage.getAllSavedPlaces()))
    this.unsubs.push(this.ui.handle("storage:add-saved", (p) => this.storage.addSavedPlace(p)))
    this.unsubs.push(this.ui.handle("storage:remove-saved", ({placeId}) => this.storage.removeSavedPlace(placeId)))
    this.unsubs.push(this.ui.handle("storage:list-recent", () => this.storage.getRecentSearches()))
    this.unsubs.push(this.ui.handle("storage:add-recent", (p) => this.storage.addRecentSearch(p)))
  }

  // ── UI broadcast listeners ───────────────────────────────────────────

  private wireUIBroadcasts(): void {
    this.unsubs.push(
      this.ui.on("nav:start", async (opts) => {
        const {destinationName, ...startOpts} = opts
        this.trip = {
          ...this.trip,
          status: "navigating",
          running: true,
          activeDestination: startOpts.stops?.[startOpts.stops.length - 1] ?? null,
          activeDestinationName: destinationName ?? null,
          maneuver: null,
          offRouteAt: null,
        }
        this.appendLog(`START ${destinationName ?? "(unnamed)"}`)
        this.ui.send("nav:trip-state", this.trip)
        try {
          await this.navigation.start(startOpts)
        } catch (err) {
          this.appendLog(`START error: ${err instanceof Error ? err.message : String(err)}`)
          this.trip = {...this.trip, status: "idle", running: false}
          this.ui.send("nav:trip-state", this.trip)
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:stop", () => {
        this.appendLog("STOP")
        try {
          this.navigation.stop()
        } catch {
          /* ignore */
        }
        this.trip = {
          ...this.trip,
          status: "idle",
          running: false,
          maneuver: null,
          activeDestination: null,
          routePoints: null,
          routeSteps: null,
          offRouteAt: null,
        }
        this.ui.send("nav:trip-state", this.trip)
        this.refreshHUD()
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:deviate", () => {
        try {
          this.navigation.dev.deviate()
        } catch (err) {
          this.appendLog(`deviate failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-destination", (place) => {
        if (place) this.appendLog(`set-destination ${place.name}`)
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-dev-settings", (partial) => {
        const next = {...this.devSettings, ...partial}
        // Forward changed dev toggles into the navigation SDK's `dev`
        // surface so the wrongSidewalk / skipCrossings flags actually
        // affect the trip. `simulate` and `speedMultiplier` are passed
        // to navigation.start() via the nav:start payload — applying
        // them mid-trip would require a stop+restart, which we don't
        // do here.
        try {
          if (partial.wrongSidewalk !== undefined && partial.wrongSidewalk !== this.devSettings.wrongSidewalk) {
            this.navigation.dev.setWrongSidewalkOffset(partial.wrongSidewalk)
          }
          if (partial.skipCrossings !== undefined && partial.skipCrossings !== this.devSettings.skipCrossings) {
            this.navigation.dev.setSkipCrossings(partial.skipCrossings)
          }
        } catch (err) {
          this.appendLog(`dev-settings forward failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        this.devSettings = next
        this.ui.send("nav:dev-settings-update", this.devSettings)
      }),
    )

    this.unsubs.push(
      this.ui.handle("test:show-text-test", ({text, durationMs}) => {
        this.display.showText(text, durationMs)
      }),
    )

    // Mid-trip hydration: every fresh WebView open gets a snapshot.
    this.unsubs.push(this.ui.onOpen(() => this.ui.send("nav:snapshot", this.buildSnapshot())))
  }

  // ── Glasses HUD pump ─────────────────────────────────────────────────
  // refreshHUD() is called explicitly at the end of each state mutator
  // in wireSensorSubscriptions / wireUIBroadcasts. No monkey-patching of
  // ui.send — clearer than reactive auto-refresh.

  private wireHUDPump(): void {
    // Prime an initial HUD render once subscriptions warm up so the
    // welcome message shows even before the first GPS fix. Stored on
    // an unsub so dispose() can cancel before it fires — otherwise a
    // session that disconnects within 250ms of start would re-display
    // "Welcome" on the glasses after dispose() has already cleared.
    const handle = setTimeout(() => {
      try {
        this.refreshHUD()
      } catch {
        /* ignore */
      }
    }, 250)
    this.unsubs.push(() => clearTimeout(handle))
  }

  private refreshHUD(): void {
    const {status, running, activeDestinationName, maneuver} = this.trip

    let next: string | null = null
    let durationMs: number | undefined

    if (status === "arrived") {
      const at = activeDestinationName ? ` at ${activeDestinationName}` : ""
      next = `You have arrived${at}`
      durationMs = 10_000
    } else if (!running) {
      next = "Welcome to Mentra Navigation!\nPick a destination to get started."
      durationMs = 5_000
    } else if (status === "rerouting") {
      next = "Rebuilding route…"
    } else if (this.activePivot) {
      if (this.activePivot.maneuver === "CROSS_STREET") {
        // Crossing pivots use the across-the-street road as their
        // `toRoad`. "Cross to Fell St" reads naturally as the user
        // steps off the curb.
        const namedRoad = isRealRoadName(this.activePivot.toRoad)
        next = namedRoad ? `Cross to ${namedRoad}` : "Cross the street"
      } else {
        const verb = this.activePivot.direction === "right" ? "Turn right" : "Turn left"
        const namedRoad = isRealRoadName(this.activePivot.toRoad)
        const onto = namedRoad ? `onto ${namedRoad}` : null
        next = [verb, onto].filter(Boolean).join("\n")
      }
    } else if (this.upcomingPivot && this.coords) {
      const dist = haversineMeters(
        {lat: this.coords.lat, lng: this.coords.lng},
        {lat: this.upcomingPivot.lat, lng: this.upcomingPivot.lng},
      )
      const isCross = this.upcomingPivot.maneuver === "CROSS_STREET"
      const distStr = formatDistance(dist)
      if (isCross) {
        // Use the across-street road name when geocode populated it.
        // Falls back to a neutral "Cross the street" prompt otherwise.
        const namedRoad = isRealRoadName(this.upcomingPivot.toRoad)
        const verb = namedRoad ? `Cross to ${namedRoad}` : "Cross the street"
        next = `${verb} in ${distStr}`
      } else {
        const verb = this.upcomingPivot.direction === "right" ? "Turn right" : "Turn left"
        const nextRoad = isRealRoadName(this.upcomingPivot.fromRoad)
        const topLine = nextRoad ? `Onto ${nextRoad}` : null
        next = [topLine, `${verb} in ${distStr}`].filter(Boolean).join("\n")
      }
    } else if (maneuver?.distanceToDestinationMeters != null && maneuver.distanceToDestinationMeters >= 0) {
      next = `Arriving in ${formatDistance(maneuver.distanceToDestinationMeters)}`
    } else if (running) {
      next = "Arriving"
    }

    if (next == null) return
    // Coalesce — don't spam the glasses with the same frame.
    const key = `${next} ${durationMs ?? 0}`
    if (key === this.lastHudKey) return
    this.lastHudKey = key
    this.display.showText(next, durationMs)
  }

  // ── Permission + initial fix priming ─────────────────────────────────

  private primeNavigationPermission(): void {
    this.session
      .waitForReady()
      .then(() => this.navigation.requestPermission())
      .then((r) => this.appendLog(`requestPermission: ${JSON.stringify(r)}`))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[NavigationController] requestPermission failed", err)
      })
  }

  private seedInitialFix(): void {
    this.location
      .getOnce()
      .then((d) => {
        if (this.coords) return
        this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
        this.ui.send("nav:coords", this.coords)
      })
      .catch(() => {
        /* streaming updates will arrive when location stabilises */
      })
  }

  // ── Log + maneuver helpers ───────────────────────────────────────────

  private appendLog(line: string): void {
    const entry: LogEntry = {id: ++this.logSeq, ts: Date.now(), line}
    this.log = [entry, ...this.log].slice(0, 100)
    this.ui.send("nav:log-append", entry)
  }

  private formatUpdate(u: NavUpdate): string {
    switch (u.kind) {
      case "maneuver":
        return `MANEUVER ${u.maneuverType} dist=${u.distanceMeters.toFixed(0)}m`
      case "off_route":
        return `OFF_ROUTE ${Math.round(u.offRouteDistanceMeters)}m off`
      case "rerouting":
        return "REROUTING"
      case "arrived":
        return "ARRIVED"
      case "error":
        return `ERROR ${u.message}`
      default:
        return `UPDATE ${(u as {kind?: string}).kind ?? "?"}`
    }
  }

  // ── Snapshot + dispose ───────────────────────────────────────────────

  private buildSnapshot(): NavSnapshot {
    return {
      coords: this.coords,
      heading: this.heading,
      trip: this.trip,
      activePivot: this.activePivot,
      upcomingPivot: this.upcomingPivot,
      log: [...this.log],
      devSettings: this.devSettings,
    }
  }

  private dispose(): void {
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    try {
      this.display.clear()
    } catch {
      /* ignore */
    }
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
  }
}

// ── Module helpers ─────────────────────────────────────────────────────

function isRealRoadName(s: string | undefined | null): string | null {
  if (!s) return null
  if (/^Pivot \d+$/i.test(s)) return null
  return s
}

/**
 * Diagnostic log fired whenever the live trip's onRoute event lands.
 * Mirrors the `[NavPreview]` block the miniapp prints during preview,
 * so we can eyeball-compare preview vs live for the same destination.
 *
 * Post-Phase-2 the route this sees should be REST-derived (synthetic
 * onRoute from navigation.start). Reroutes still fall through the
 * native path until Phase 3 — when those land here, the polyline and
 * step shape are the Nav SDK's, which is exactly what we want to
 * spot.
 */
function logLiveRoute(route: NavRoute): void {
  const steps = route.steps ?? []
  const polyline = route.points ?? []
  const annotated = steps.map((s, i) => ({stepIdx: i, name: s.road ?? null}))
  const roads: string[] = []
  for (const a of annotated) {
    if (!a.name) continue
    if (roads.length > 0 && roads[roads.length - 1].toLowerCase() === a.name.toLowerCase()) continue
    roads.push(a.name)
  }
  console.log(`[NavLive] roads: ${roads.join(" → ")}`)
  console.log(
    `[NavLive] resolution:\n` +
      annotated.map((a) => `  step ${a.stepIdx} → ${a.name ?? "(none)"}`).join("\n"),
  )
  console.log(
    `[NavLive] steps:\n` +
      steps
        .map(
          (s, i) =>
            `  step ${i}: ${s.road ?? "(unnamed)"} | ${s.maneuver ?? "—"} | ${s.distanceMeters}m`,
        )
        .join("\n"),
  )
  const stride = Math.max(1, Math.ceil(polyline.length / 30))
  const sampled = polyline.filter((_, i) => i % stride === 0 || i === polyline.length - 1)
  console.log(
    `[NavLive] polyline (${polyline.length} pts, showing ${sampled.length}):\n` +
      sampled.map((p, i) => `  ${i}: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`).join("\n"),
  )
  // Turn list derived from road→road transitions, same logic the
  // preview block uses minus the polyline-bend filter (we trust the
  // SDK's resolved step list at this point).
  const turns: string[] = []
  for (let i = 0; i < annotated.length - 1; i++) {
    const here = annotated[i]
    const next = annotated[i + 1]
    if (!here.name || !next.name) continue
    if (here.name.toLowerCase() === next.name.toLowerCase()) continue
    const junction = steps[here.stepIdx]
    turns.push(
      `  ${turns.length}: ${here.name} → ${next.name} @ (${junction.lat.toFixed(5)}, ${junction.lng.toFixed(5)})`,
    )
  }
  console.log(`[NavLive] turns (${turns.length}):\n${turns.join("\n")}`)
}
