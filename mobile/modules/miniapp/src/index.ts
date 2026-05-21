/**
 * @mentra/miniapp — SDK for building MentraOS local miniapps.
 *
 * Public entry point. Consumers do:
 *
 *   import {MiniappSession} from "@mentra/miniapp"
 *   import {useSession} from "@mentra/miniapp/react"
 *   import {MiniappRequestType} from "@mentra/miniapp/protocol"
 */

import {installDevReloadListenerIfDevMode} from "./dev-reload"

// Auto-install the dev-reload listener on module import so authors get live
// reload for free in dev builds. No-op in production (gated on
// window.MentraOS.miniappDeveloperMode).
installDevReloadListenerIfDevMode()

export {MiniappSession, NotConnectedError} from "./session"
export type {
  ConnectAckPayload,
  GlassesCapabilities,
  MiniappRequestError,
  MiniappSessionOptions,
  MiniappVisibility,
} from "./session"

export {makeRequestId, parseEnvelope, serializeEnvelope} from "./envelope"
export type {MiniappEnvelope} from "./envelope"

export {getMentraOSGlobals} from "./globals"
export type {
  MentraOSGlobals,
  MiniappCapsuleMenuRect,
  MiniappColorScheme,
  MiniappSafeAreaInsets,
} from "./globals"

export {MiniappErrorCode, MiniappRequestType, MiniappResponseType, MiniappStreamType} from "./protocol"

// Hardware requirement types — re-exported from @mentra/types so miniapp
// authors can type their miniapp.json manifest without pulling in the types
// package directly. Keep explicit exports (enums as value, interfaces as
// type) per @mentra/types' Bun-compat convention.
export {HardwareType, HardwareRequirementLevel} from "@mentra/types"
export type {HardwareRequirement} from "@mentra/types"

// Transports — exported for advanced uses (forced transport injection, tests)
export {createTransport} from "./transport/auto"
export type {CreateTransportOptions} from "./transport/auto"
export {PostMessageTransport} from "./transport/postmessage"
export {LocalSocketTransport} from "./transport/local-socket"
export type {LocalSocketTransportOptions} from "./transport/local-socket"
export {MockTransport, isMockExplicitlyRequested} from "./transport/mock"
export type {MockTransportOptions} from "./transport/mock"
export type {Transport, TransportDisconnectHandler, TransportMessageHandler} from "./transport/types"

// Module types — useful for typing handlers in consumer code
export type {
  BitmapView,
  ClearView,
  DashboardCard,
  DisplayOptions,
  DoubleTextWall,
  Layout,
  LayoutType,
  ReferenceCard,
  TextWall,
  ViewType,
} from "./modules/display"
export type {
  AudioChunkData,
  BatteryData,
  ButtonPressData,
  CalendarEventData,
  ConnectionData,
  HeadPositionData,
  LocationData,
  NotificationDismissedData,
  PhoneNotificationData,
  TouchData,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
  VadData,
} from "./modules/events"
export type {PlayAudioOptions, SpeakOptions, SpeakResult, SpeakerState, SpeakerStateEvent} from "./modules/speaker"
export type {PhotoTaken, SetCameraFovOptions, TakePhotoOptions} from "./modules/camera"
export type {DashboardMode} from "./modules/dashboard"
export type {LedColor, LedControlOptions} from "./modules/led"
export type {StartUnmanagedOptions, StartManagedOptions, ManagedStreamResult, StreamStatus} from "./modules/stream"
export type {ShareOptions, ShareResult, DownloadOptions, DownloadResult} from "./modules/system"

// Domain module types — exported so consumers can type module references
// (rare; most authors interact via session.<module>.<method> directly).
export type {DisplayManager} from "./modules/display"
export type {GlassesModule} from "./modules/glasses"
export type {ImuModule} from "./modules/imu"
export type {InputModule} from "./modules/input"
export type {LocationModule} from "./modules/location"
export type {MicModule} from "./modules/mic"
export type {PermissionsModule, PermissionErrorEvent} from "./modules/permissions"
export type {PhoneModule, PhoneNotificationsModule, PhoneCalendarModule} from "./modules/phone"
export type {TranscriptionModule, TranscriptionConfig} from "./modules/transcription"
export type {TranslationModule} from "./modules/translation"
export type {SpeakerModule} from "./modules/speaker"

// Permission types
export type {PermissionType, PermissionRecord} from "./session"
