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
