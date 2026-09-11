/**
 * navStore — Zustand store fed by background channel pushes. The UI
 * never touches MiniappSession or the managers directly. Background
 * is the source of truth; the store mirrors what background broadcasts.
 *
 * `installChannelSubscribers()` runs once from main.tsx and wires every
 * `nav:*` channel into the store. It also requests a fresh snapshot via
 * `mentra.request("nav:get-snapshot")` so a freshly-mounted WebView
 * doesn't wait for the background-side onOpen snapshot.
 */

import {create} from "zustand"

import type {
  DevSettings,
  GlassesCapabilitySnapshot,
  LogEntry,
  NavSnapshot,
  TripState,
  UnitSystem,
  VoiceGuidanceMode,
} from "../../shared/types"

type NavStore = NavSnapshot & {
  apply(snapshot: Partial<NavSnapshot>): void
  applyTrip(trip: TripState): void
  applyDevSettings(s: DevSettings): void
  applyUnitSystem(u: UnitSystem): void
  applyVoiceGuidance(mode: VoiceGuidanceMode, capabilities?: GlassesCapabilitySnapshot): void
  appendLog(entry: LogEntry): void
  clearLog(): void
}

const initialSnapshot: NavSnapshot = {
  coords: null,
  heading: null,
  trip: {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    routeSteps: null,
    offRouteAt: null,
    arrivalSide: null,
  },
  activePivot: null,
  upcomingPivot: null,
  log: [],
  devSettings: {
    simulate: false,
    speedMultiplier: 5,
    wrongSidewalk: false,
    skipCrossings: false,
    useRawInstructions: true,
    largeMapEnabled: false,
  },
  unitSystem: "metric",
  voiceGuidanceMode: "off",
  capabilities: {modelName: null, hasDisplay: false, canPosition: false, hasSpeaker: false, hasButton: false},
}

export const useNavStore = create<NavStore>((set) => ({
  ...initialSnapshot,
  apply: (snapshot) => set(snapshot),
  applyTrip: (trip) => set({trip}),
  applyDevSettings: (devSettings) => set({devSettings}),
  applyUnitSystem: (unitSystem) => set({unitSystem}),
  applyVoiceGuidance: (voiceGuidanceMode, capabilities) =>
    set((state) => ({voiceGuidanceMode, capabilities: capabilities ?? state.capabilities})),
  appendLog: (entry) => set((s) => ({log: [entry, ...s.log].slice(0, 100)})),
  clearLog: () => set({log: []}),
}))

let installed = false
export function installChannelSubscribers(): void {
  if (installed) return
  installed = true

  mentra.on("nav:snapshot", (snap) => useNavStore.getState().apply(snap))
  mentra.on("nav:coords", (coords) => useNavStore.setState({coords}))
  mentra.on("nav:heading", ({degrees}) => useNavStore.setState({heading: degrees}))
  mentra.on("nav:trip-state", (trip) => useNavStore.getState().applyTrip(trip))
  mentra.on("nav:pivots", ({active, upcoming}) => useNavStore.setState({activePivot: active, upcomingPivot: upcoming}))
  mentra.on("nav:route", ({points, steps}) => {
    useNavStore.setState((s) => ({trip: {...s.trip, routePoints: points, routeSteps: steps}}))
  })
  mentra.on("nav:log-append", (entry) => useNavStore.getState().appendLog(entry))
  mentra.on("nav:log-clear", () => useNavStore.getState().clearLog())
  mentra.on("nav:dev-settings-update", (s) => useNavStore.getState().applyDevSettings(s))
  mentra.on("nav:units-update", ({unitSystem}) => useNavStore.getState().applyUnitSystem(unitSystem))
  mentra.on("nav:voice-guidance-update", ({voiceGuidanceMode, capabilities}) =>
    useNavStore.getState().applyVoiceGuidance(voiceGuidanceMode, capabilities),
  )

  // Best-effort snapshot kickoff — onOpen also fires one from background,
  // but issuing this explicitly ensures we hydrate even if the open
  // round-trips slowly.
  mentra
    .request("nav:get-snapshot", undefined as never)
    .then((snap) => useNavStore.getState().apply(snap))
    .catch(() => {
      /* ignore — onOpen snapshot will arrive */
    })
}
