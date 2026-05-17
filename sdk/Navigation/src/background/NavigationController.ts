/**
 * NavigationController — the always-on logic for the Mentra Map
 * miniapp. Owns MiniappSession subscriptions, trip state, the glasses
 * HUD logic, storage reads/writes, and Places REST. Lives for the
 * entire session — closing the WebView does NOT stop navigation.
 *
 * The UI WebView is a thin renderer fed via session.ui.send and the
 * UI's mentra.send / mentra.request bus declared in shared/channels.ts.
 *
 * Task 18 ships a skeleton — managers wired, state initialised, dispose
 * stubs in place. Task 19 fills in subscriptions, RPC handlers, UI
 * broadcasts, and the glasses HUD pump.
 */

import type {MiniappSession, Pivot, UIModule} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {Coords, DevSettings, LogEntry, NavSnapshot, TripState} from "../shared/types"

import {CompassManager} from "./managers/CompassManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NavigationManager} from "./managers/NavigationManager"
import {PlacesManager} from "./managers/PlacesManager"
import {SimpleStorageManager} from "./managers/SimpleStorageManager"

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

  // Canonical state (mirrored to UI via session.ui.send).
  protected coords: Coords | null = null
  protected heading: number | null = null
  protected mapsReady = false // UI manages this; controller just tracks it for snapshot
  protected trip: TripState = {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    offRouteAt: null,
  }
  protected activePivot: Pivot | null = null
  protected upcomingPivot: Pivot | null = null
  protected log: LogEntry[] = []
  protected devSettings: DevSettings = {
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

    // Sensor subscriptions, RPC handlers, UI broadcast listeners, and
    // the glasses HUD pump are wired in Task 19. The skeleton only
    // hooks the dispose path so we tear down cleanly on session end.

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  protected buildSnapshot(): NavSnapshot {
    return {
      coords: this.coords,
      heading: this.heading,
      mapsReady: this.mapsReady,
      trip: this.trip,
      activePivot: this.activePivot,
      upcomingPivot: this.upcomingPivot,
      log: [...this.log],
      devSettings: this.devSettings,
    }
  }

  protected dispose(): void {
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
