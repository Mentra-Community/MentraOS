/**
 * @mentra/miniapp/background — background-side SDK entry point.
 *
 * Imported from a miniapp's `src/background/index.ts` to access the
 * per-miniapp `MiniappSession` and its typed `session.*` module
 * wrappers. This is the **always-running JSContext side** of a two-layer
 * miniapp.
 *
 * What's NOT in this entry point:
 *   - `mentra` WebView global (UI-only — import from `@mentra/miniapp/ui`).
 *   - `MentraProvider` / React hooks (UI-only).
 *   - Any DOM-bound API. The JSContext has no DOM.
 *
 * Importing the wrong sub-path is caught at compile time by the
 * separate type-roots on each `exports` entry.
 */

export {MiniappSession, type MiniappSessionOptions} from "../session"
export {registerMiniapp, type MiniappInitHandler} from "./register"

// Event / data type re-exports — these are payload shapes a miniapp's
// background-side handlers consume from session.transcription.on, etc.
export type {
  TranscriptionData,
  TranslationData,
  ButtonPressData,
  AudioChunkData,
  VadData,
  BatteryData,
  ConnectionData,
  HeadPositionData,
  LocationData,
  PhoneNotificationData,
  NotificationDismissedData,
  CalendarEventData,
  HeadingData,
  TouchData,
  UnsubscribeFn,
} from "../modules/events"

// Public envelope + protocol types so authors can write strongly-typed
// glue when they need to fall back to session.sendOneShot / sendRequest.
export {
  MiniappRequestType,
  MiniappResponseType,
  MiniappStreamType,
  MiniappErrorCode,
} from "../protocol"

// Session module types — useful for typing controller classes or
// utility helpers that take a session-like dependency.
export type {DisplayManager} from "../modules/display"
export type {CameraModule} from "../modules/camera"
export type {DashboardAPI} from "../modules/dashboard"
export type {GlassesModule} from "../modules/glasses"
export type {HeadingModule} from "../modules/heading"
export type {ImuModule} from "../modules/imu"
export type {InputModule} from "../modules/input"
export type {LedModule} from "../modules/led"
export type {LocationModule} from "../modules/location"
export type {MicModule} from "../modules/mic"
export type {NavigationModule} from "../modules/navigation"
export type {PermissionsModule} from "../modules/permissions"
export type {PhoneModule} from "../modules/phone"
export type {SimpleStorage} from "../modules/storage"
export type {SpeakerModule} from "../modules/speaker"
export type {StreamModule} from "../modules/stream"
export type {SystemModule} from "../modules/system"
export type {TranscriptionModule} from "../modules/transcription"
export type {TranslationModule} from "../modules/translation"
export type {UIModule, UIChannelHandler, UIUnsubscribe} from "../modules/ui"

// Argument enums + option types — for authors writing controllers that pass
// these into session.* method calls (or that build typed helpers around them).
// Intentionally NOT re-exported from `@mentra/miniapp/ui` — the WebView half
// never touches these directly. UI talks to background via mentra.send with
// the author's own `Channels` registry; background is where these enums show
// up as method args.
export type {LedColor, LedControlOptions} from "../modules/led"
export type {
  ViewType,
  LayoutType,
  Layout,
  DisplayOptions,
  TextWall,
  DoubleTextWall,
  ReferenceCard,
  DashboardCard,
  BitmapView,
  ClearView,
} from "../modules/display"
export type {DashboardMode} from "../modules/dashboard"
export type {
  PlayAudioOptions,
  SpeakOptions,
  SpeakResult,
  SpeakerState,
  SpeakerStateEvent,
} from "../modules/speaker"
export type {
  ShareOptions,
  ShareResult,
  DownloadOptions,
  DownloadResult,
} from "../modules/system"
export type {TranscriptionConfig} from "../modules/transcription"
export type {PermissionErrorEvent} from "../modules/permissions"
export type {
  MiniappVisibility,
  PermissionType,
  PermissionRecord,
  GlassesCapabilities,
  ConnectAckPayload,
  MiniappRequestError,
} from "../session"
export type {MiniappColorScheme} from "../globals"
// Navigation — exported as a single block since the types reference each other.
export type {
  LatLng,
  TravelMode,
  ManeuverKind,
  RouteAvoidances,
  NavManeuver,
  NavOffRoute,
  NavRerouting,
  NavArrived,
  NavError,
  NavUpdate,
  NavRoute,
  PivotOptions,
  Pivot,
  PivotEvent,
  NavStep,
  NavigationDev,
  StartNavigationOptions,
  NavState,
  NavPermissionResult,
  ComputeRouteOptions,
  ComputedRouteStep,
  ComputedRoute,
  ComputeRouteResult,
} from "../modules/navigation"
