/**
 * @mentra/miniapp — SDK for building MentraOS local miniapps.
 *
 * Public entry point. Consumers do:
 *
 *   import {MiniappSession} from "@mentra/miniapp"            // background JSContext
 *   import {useColorScheme} from "@mentra/miniapp/react"      // UI WebView hooks
 *   import {MiniappRequestType} from "@mentra/miniapp/protocol"
 */

import {installDevReloadListenerIfDevMode} from "./dev-reload"

// Auto-install the dev-reload listener on module import so authors get live
// reload for free in dev builds. No-op in production (gated on
// window.MentraOS.miniappDeveloperMode).
installDevReloadListenerIfDevMode()

export {MiniappSession, NotConnectedError} from "./session"
export type {
  AuthUpdatePayload,
  ConnectAckPayload,
  DisplayCapabilities,
  GlassesCapabilities,
  MiniappAuthState,
  MiniappRequestError,
  MiniappSessionOptions,
  MiniappVisibility,
} from "./session"
export type {AuthFetchOptions, AuthModule} from "./modules/auth"

export {makeRequestId, parseEnvelope, serializeEnvelope} from "./envelope"
export type {MiniappEnvelope} from "./envelope"

export {getMentraOSGlobals} from "./globals"
export type {MentraOSGlobals, MiniappCapsuleMenuRect, MiniappColorScheme, MiniappSafeAreaInsets} from "./globals"

export {MiniappErrorCode, MiniappRequestType, MiniappResponseType, MiniappStreamType} from "./protocol"
export {CLOUD_STATUS_STREAM} from "./modules/cloud"

// Language registry (issue 021): canonical language types + the validation
// error the typed transcription/translation surfaces throw.
export {
  MiniappValidationError,
  SUPPORTED_LANGUAGE_HINTS,
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  isTranscriptionLanguage,
} from "./modules/languages"
export type {LanguageHint, TranscriptionLanguage} from "./modules/languages"
export type {CloudClientAudioTransport, CloudClientConnectionStatus, CloudClientStatus} from "./modules/cloud"

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
  DisplayBreakMode,
  RenderBox,
  RenderElement,
  RenderOptions,
  RenderRectStyle,
  RenderResult,
  RenderTextStyle,
  ViewType,
} from "./modules/display"
export type {
  AccelData,
  AudioChunkData,
  BatteryData,
  ButtonPressData,
  ConnectionData,
  HeadingData,
  HeadPositionData,
  LocationData,
  NotificationDismissedData,
  PhoneNotificationData,
  TouchData,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
  VadData,
  WifiData,
} from "./modules/events"
export type {CalendarEvent, CalendarListOptions, CalendarListResult} from "./modules/phone"
export type {
  PlayAudioOptions,
  SpeakOptions,
  SpeakResult,
  SpeakerState,
  SpeakerStateEvent,
  SpeakerStreamOptions,
  SpeakerStreamSampleRate,
  SpeakerStreamWriteResult,
} from "./modules/speaker"
export {SpeakerStreamWriter, SPEAKER_STREAM_MAX_BUFFERED_MS, SPEAKER_WRITE_CHUNK_BYTES} from "./modules/speaker"
export type {
  CameraFovPreset,
  CameraFovRequest,
  CameraFovResult,
  CameraRoiPosition,
  PhotoTaken,
  SetCameraFovOptions,
  StartVideoRecordingOptions,
  StopVideoRecordingOptions,
  TakePhotoOptions,
  VideoRecordingStarted,
} from "./modules/camera"
export type {DashboardMode} from "./modules/dashboard"
export type {CloudModule} from "./modules/cloud"
export type {LedColor, LedControlOptions} from "./modules/led"
export type {
  RestreamDestination,
  StartStreamOptions,
  StreamAudioConfig,
  StreamResolvedConfig,
  StreamResult,
  StreamStatus,
  StreamVideoConfig,
} from "./modules/stream"
export type {
  ShareOptions,
  ShareResult,
  DownloadOptions,
  DownloadResult,
  ScanQrOptions,
  ScanQrResult,
} from "./modules/system"
export type {
  MiniappInfo,
  MiniappActionInfo,
  MiniappCompatibility,
  ListMiniappsOptions,
  InstallMiniappRequest,
  InstallMiniappResult,
  InstallMiniappPhase,
  InstallMiniappProgress,
  MiniappInstallAuthorization,
} from "./modules/miniapps"
export type {ActionContext, ActionHandler, InvokeOptions} from "./modules/actions"

// Domain module types — exported so consumers can type module references
// (rare; most authors interact via session.<module>.<method> directly).
export type {DisplayManager} from "./modules/display"
export type {MiniappsModule} from "./modules/miniapps"
export type {ActionsModule} from "./modules/actions"
export type {GlassesModule} from "./modules/glasses"
export type {HeadingModule} from "./modules/heading"
export type {ImuModule} from "./modules/imu"
export type {InputModule} from "./modules/input"
export type {LocationModule} from "./modules/location"
export type {MicModule} from "./modules/mic"
export type {
  ComputedRoute,
  ComputedRouteStep,
  ComputeRouteOptions,
  ComputeRouteResult,
  LatLng,
  NavArrived,
  NavError,
  NavigationModule,
  NavManeuver,
  NavOffRoute,
  NavPermissionResult,
  NavPlaceDetails,
  NavPlaceSuggestion,
  NavRerouting,
  NavRoute,
  NavState,
  NavStep,
  NavUpdate,
  Pivot,
  PivotEvent,
  PivotOptions,
  RouteAvoidances,
  StartNavigationOptions,
  TravelMode,
} from "./modules/navigation"
export type {PermissionsModule, PermissionErrorEvent} from "./modules/permissions"
export type {PhoneModule, PhoneNotificationsModule, PhoneCalendarModule} from "./modules/phone"
export type {TranscriptionModule, TranscriptionConfig, TranscriptionOptions} from "./modules/transcription"
export type {TranslationModule} from "./modules/translation"
export type {SpeakerModule} from "./modules/speaker"

// Permission types
export type {PermissionType, PermissionRecord} from "./session"
