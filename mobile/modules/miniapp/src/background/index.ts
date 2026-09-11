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
export {registerMiniapp, type MiniappInitHandler, type TypedMiniappSession} from "./register"

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
  WifiData,
  HeadPositionData,
  AccelData,
  LocationData,
  PhoneNotificationData,
  NotificationDismissedData,
  HeadingData,
  TouchData,
  UnsubscribeFn,
} from "../modules/events"
export type {CalendarEvent, CalendarListOptions, CalendarListResult} from "../modules/phone"

// Public envelope + protocol types so authors can write strongly-typed
// glue when they need to fall back to session.sendOneShot / sendRequest.
export {MiniappRequestType, MiniappResponseType, MiniappStreamType, MiniappErrorCode} from "../protocol"
export {
  MiniappValidationError,
  SUPPORTED_LANGUAGE_HINTS,
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  isTranscriptionLanguage,
} from "../modules/languages"
export type {LanguageHint, TranscriptionLanguage} from "../modules/languages"

// Action handler types — for typing `session.actions.handle(id, fn)` handlers
// (the registering side lives in the background JSContext). `InvokeOptions` is
// for system miniapps that call other apps' actions via `session.actions.invoke`.
export type {ActionContext, ActionHandler, InvokeOptions} from "../modules/actions"

// Session module types — useful for typing controller classes or
// utility helpers that take a session-like dependency.
export type {DisplayManager} from "../modules/display"
export type {
  CameraFovPreset,
  CameraFovRequest,
  CameraFovResult,
  CameraModule,
  CameraRoiPosition,
  SetCameraFovOptions,
} from "../modules/camera"
export type {
  CloudClientAudioTransport,
  CloudClientConnectionStatus,
  CloudClientStatus,
  CloudModule,
} from "../modules/cloud"
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
export {BlobModule, BlobWriter, BlobReader, BLOB_WRITE_CHUNK_BYTES, BLOB_READ_ALL_MAX_BYTES} from "../modules/blob"
export type {BlobMeta, BlobSetOptions, BlobSetFromUrlOptions, BlobImportOptions} from "../modules/blob"
export {bytesToBase64, base64ToBytes} from "../modules/base64"
export type {SpeakerModule} from "../modules/speaker"
export type {StreamModule} from "../modules/stream"
export type {SystemModule} from "../modules/system"
export type {TranscriptionModule} from "../modules/transcription"
export type {TranslationModule} from "../modules/translation"
export type {UIModule, UIChannelHandler, UIUnsubscribe} from "../modules/ui"
export type {Rpc, IsRpc, RpcReq, RpcRes, RpcRequestOptions, RpcHandlerContext} from "../modules/ui"
export {MentraRpcError, MentraRpcTimeoutError} from "../modules/ui"

// Argument enums + option types — for authors writing controllers that pass
// these into session.* method calls (or that build typed helpers around them).
// Intentionally NOT re-exported from `@mentra/miniapp/ui` — the WebView half
// never touches these directly. UI talks to background via mentra.send with
// the author's own `Channels` registry; background is where these enums show
// up as method args.
export type {LedColor, LedControlOptions} from "../modules/led"
export type {
  ViewType,
  DisplayBreakMode,
  RenderBox,
  RenderElement,
  RenderOptions,
  RenderRectStyle,
  RenderResult,
  RenderTextStyle,
} from "../modules/display"
export type {DashboardMode} from "../modules/dashboard"
export type {PlayAudioOptions, SpeakOptions, SpeakResult, SpeakerState, SpeakerStateEvent} from "../modules/speaker"
export type {
  ShareOptions,
  ShareResult,
  DownloadOptions,
  DownloadResult,
  ScanQrOptions,
  ScanQrResult,
} from "../modules/system"
export type {TranscriptionConfig, TranscriptionOptions} from "../modules/transcription"
export type {PermissionErrorEvent} from "../modules/permissions"
export type {
  AuthUpdatePayload,
  MiniappVisibility,
  PermissionType,
  PermissionRecord,
  GlassesCapabilities,
  ConnectAckPayload,
  MiniappAuthState,
  MiniappRequestError,
} from "../session"
export type {AuthFetchOptions, AuthModule} from "../modules/auth"
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
