/**
 * @mentra/miniapp — SDK for building MentraOS local miniapps.
 *
 * Public entry point. Consumers do:
 *
 *   import {MiniappSession} from "@mentra/miniapp"
 *   import {useSession} from "@mentra/miniapp/react"
 *   import {MiniappRequestType} from "@mentra/miniapp/protocol"
 */

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

// Transports — exported for advanced uses (forced transport injection, tests)
export {createTransport} from "./transport/auto"
export type {CreateTransportOptions} from "./transport/auto"
export {PostMessageTransport} from "./transport/postmessage"
export {LocalSocketTransport} from "./transport/local-socket"
export type {LocalSocketTransportOptions} from "./transport/local-socket"
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
} from "./modules/layouts"
export type {
  AudioChunkData,
  BatteryData,
  ButtonPressData,
  CalendarEventData,
  ConnectionData,
  HeadPositionData,
  LocationData,
  PhoneNotificationData,
  TouchData,
  TranscriptionData,
  TranslationData,
  UnsubscribeFn,
  VadData,
} from "./modules/events"
export type {PlayAudioOptions, SpeakOptions, SpeakResult} from "./modules/audio"
export type {PhotoTaken, SetCameraFovOptions, TakePhotoOptions} from "./modules/camera"
export type {DashboardMode} from "./modules/dashboard"
export type {LedColor, LedControlOptions} from "./modules/led"
export type {StartUnmanagedOptions, StartManagedOptions, ManagedStreamResult, StreamStatus} from "./modules/stream"
export type {ShareOptions, ShareResult, DownloadOptions, DownloadResult} from "./modules/system"
export type {NavArrived, NavError, NavManeuver, NavRerouting, NavUpdate} from "./modules/navigation"
