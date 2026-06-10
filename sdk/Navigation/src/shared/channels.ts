/**
 * Typed channel registry — the single source of truth for every name
 * that flows between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler
 * inlines the declarations so there's no runtime cross-boundary I/O.
 *
 * Channels wrapped in `Rpc<Req, Res>` are RPC (call via mentra.request /
 * session.ui.handle). Everything else is broadcast (mentra.send /
 * session.ui.on / session.ui.send).
 */

import type {Rpc} from "@mentra/miniapp/ui"
import type {
  ComputeRouteOptions,
  ComputeRouteResult,
  NavPermissionResult,
  Pivot,
  StartNavigationOptions,
} from "@mentra/miniapp"

import type {
  Coords,
  DevSettings,
  LogEntry,
  NavRouteStep,
  NavSnapshot,
  PlaceDetails,
  PlaceSuggestion,
  SavedPlace,
  TripState,
} from "./types"

export interface Channels {
  // ── background → UI broadcasts ─────────────────────────────────────────
  "nav:snapshot": NavSnapshot                              // on ui.onOpen
  "nav:coords": Coords                                     // hot
  "nav:heading": {degrees: number}                         // hot, 10Hz throttled
  "nav:trip-state": TripState                              // on transitions
  "nav:route": {points: {lat: number; lng: number}[]; steps: NavRouteStep[] | null}      // on onRoute
  "nav:pivots": {active: Pivot | null; upcoming: Pivot | null}
  "nav:log-append": LogEntry
  "nav:log-clear": Record<string, never>
  "nav:dev-settings-update": DevSettings

  // ── UI → background broadcasts (fire-and-forget) ───────────────────────
  "nav:start": StartNavigationOptions & {destinationName?: string}
  "nav:stop": Record<string, never>
  "nav:deviate": Record<string, never>
  "nav:set-destination": PlaceDetails | null
  "nav:set-dev-settings": Partial<DevSettings>
  "nav:set-show-minimap": boolean

  // ── UI → background RPC ────────────────────────────────────────────────
  "nav:compute-route": Rpc<ComputeRouteOptions, ComputeRouteResult>
  "nav:request-permission": Rpc<void, NavPermissionResult>
  "nav:get-snapshot": Rpc<void, NavSnapshot>
  "nav:get-pivots": Rpc<void, Pivot[]>     // full turn list for dev debug dots

  "places:autocomplete": Rpc<{query: string; near?: {lat: number; lng: number}}, PlaceSuggestion[]>
  "places:details": Rpc<{placeId: string}, PlaceDetails>

  "storage:list-saved": Rpc<void, SavedPlace[]>
  "storage:add-saved": Rpc<SavedPlace, void>
  "storage:remove-saved": Rpc<{placeId: string}, void>
  "storage:list-recent": Rpc<void, PlaceDetails[]>
  "storage:add-recent": Rpc<PlaceDetails, void>

  // test channels
  "test:show-text-test": Rpc<{text: string; durationMs?: number}, void>
  "test:show-bitmap-test": Rpc<void, void>
  "test:count-1-to-10": Rpc<void, void>
  "test:reset-nav-permission": Rpc<void, {ok: boolean; error?: string}>
}

// Convenience: the typed shape of `window.mentra` for this miniapp.
declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
