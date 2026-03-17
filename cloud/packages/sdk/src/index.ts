// src/index.ts
export * from "./types/token";

// Message type enums
export * from "./types/message-types";

// Base message type
export * from "./types/messages/base";

// Messages by direction - export everything except the conflicting type guards
export * from "./types/messages/glasses-to-cloud";
export * from "./types/messages/cloud-to-glasses";
export * from "./types/messages/app-to-cloud";

// Utility exports
export * from "./utils/bitmap-utils";
export * from "./utils/animation-utils";

// Export cloud-to-app type guards and runtime exports
export {
  // Type guards (excluding isPhotoResponse and isRtmpStreamStatus which conflict)
  isAppConnectionAck,
  isAppConnectionError,
  isAppStopped,
  isSettingsUpdate,
  isCapabilitiesUpdate,
  isDataStream,
  isAudioChunk,
  isStreamStatusCheckResponse,
  isDashboardModeChanged,
  isDashboardAlwaysOnChanged,
  isManagedStreamStatus,
  isRequestTelemetry,
  isTelemetryResponse,
  // Re-export the cloud-to-app versions of these type guards since they're the ones
  // that should be used when dealing with CloudToAppMessage types
  isPhotoResponse as isPhotoResponseFromCloud,
  isRgbLedControlResponse as isRgbLedControlResponseFromCloud,
  isRtmpStreamStatus as isRtmpStreamStatusFromCloud,
} from "./types";

// Export cloud-to-app types (type-only exports)
export type {
  AppConnectionAck,
  AppConnectionError,
  AppStopped,
  SettingsUpdate as AppSettingsUpdate, // Alias to avoid conflict with cloud-to-glasses SettingsUpdate
  CapabilitiesUpdate,
  DataStream,
  CloudToAppMessage,
  TranslationData,
  ToolCall,
  StandardConnectionError,
  CustomMessage,
  ManagedStreamStatus,
  StreamStatusCheckResponse,
  OutputStatus,
  MentraosSettingsUpdate,
  TranscriptionData,
  TranscriptionMetadata,
  SonioxToken,
  AudioChunk,
  PermissionError,
  PermissionErrorDetail,
  AudioPlayResponse,
  RequestTelemetry,
  TelemetryLogEntry,
  TelemetryResponse,
} from "./types";

// Stream types
export * from "./types/streams";

// Layout types
export * from "./types/layouts";

// Dashboard types
export * from "./types/dashboard";

// RTMP streaming types
export * from "./types/rtmp-stream";

// Other system enums
export { AppType, LayoutType, ViewType, AppSettingType, HardwareType, HardwareRequirementLevel } from "./types/enums";

// Core model interfaces
export * from "./types/models";

// Webhook interfaces
export * from "./types/webhooks";

// Capability Discovery types
export * from "./types/capabilities";

// App session and server exports
export * from "./app/index";

// Logging exports
export * from "./logging/logger";

// Error classes
export {
  MentraError,
  MentraAuthError,
  MentraConnectionError,
  MentraTimeoutError,
  MentraValidationError,
  MentraPermissionError,
} from "./logging/errors";

// Re-export common types for convenience
// This allows developers to import commonly used types directly from the package root
// without having to know exactly which file they come from

// From messages/glasses-to-cloud.ts
export type {
  ButtonPress,
  HeadPosition,
  TouchEvent,
  GlassesBatteryUpdate,
  PhoneBatteryUpdate,
  GlassesConnectionState,
  LocationUpdate,
  CalendarEvent,
  Vad,
  PhoneNotification,
  PhoneNotificationDismissed,
  StartApp,
  StopApp,
  ConnectionInit,
  DashboardState,
  OpenDashboard,
  GlassesToCloudMessage,
  PhotoResponse,
  RgbLedControlResponse,
  ConnectionState,
  PhotoErrorDetails,
} from "./types/messages/glasses-to-cloud";

// These are enums (runtime values) — must NOT be re-exported as `export type`
// or they become unusable as values (TS1362). The `export *` at the top of
// this file already exports them correctly; these explicit exports are kept
// here as documentation but as value exports.
export { PhotoErrorCode, PhotoStage, RtmpStreamStatus, KeepAliveAck } from "./types/messages/glasses-to-cloud";

// From messages/cloud-to-glasses.ts
export type {
  ConnectionAck,
  ConnectionError,
  AuthError,
  DisplayEvent,
  AppStateChange,
  MicrophoneStateChange,
  CloudToGlassesMessage,
  PhotoRequestToGlasses,
  RgbLedControlToGlasses,
  SettingsUpdate,
  StartRtmpStream,
  StopRtmpStream,
  KeepRtmpStreamAlive,
  LedColor,
} from "./types/messages/cloud-to-glasses";

// From messages/app-to-cloud.ts
export type {
  AppConnectionInit,
  AppSubscriptionUpdate,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  AppToCloudMessage,
  PhotoRequest,
  RgbLedControlRequest,
} from "./types/messages/app-to-cloud";

// From layout.ts
export type {
  TextWall,
  DoubleTextWall,
  DashboardCard,
  ReferenceCard,
  Layout,
  DisplayRequest,
  BitmapView,
  ClearView,
} from "./types/layouts";

// Type guards - re-export the most commonly used ones for convenience
export {
  isButtonPress,
  isHeadPosition,
  isConnectionInit,
  isStartApp,
  isStopApp,
  isPhotoResponse as isPhotoResponseFromGlasses,
  isRgbLedControlResponse as isRgbLedControlResponseFromGlasses,
  isRtmpStreamStatus as isRtmpStreamStatusFromGlasses,
  isKeepAliveAck,
  isPhoneNotificationDismissed,
} from "./types/messages/glasses-to-cloud";

export {
  isConnectionAck,
  isDisplayEvent,
  isAppStateChange,
  isPhotoRequest,
  isSettingsUpdate as isSettingsUpdateToGlasses,
  isStartRtmpStream,
  isStopRtmpStream,
  isKeepRtmpStreamAlive,
  isRgbLedControl,
} from "./types/messages/cloud-to-glasses";

export {
  isAppConnectionInit,
  isAppSubscriptionUpdate,
  isDisplayRequest,
  isRtmpStreamRequest,
  isRtmpStreamStopRequest,
  isPhotoRequest as isPhotoRequestFromApp,
  isRgbLedControlRequest,
  isOwnershipRelease,
} from "./types/messages/app-to-cloud";

// Export setting-related types
export { validateAppConfig } from "./types/models";

export type {
  BaseAppSetting,
  AppSetting,
  AppSettings,
  AppConfig,
  ToolSchema,
  ToolParameterSchema,
  HardwareRequirement,
  PreviewImage,
  PhotoOrientation,
} from "./types/models";

// Export RTMP streaming types
export type { VideoConfig, AudioConfig, StreamConfig, StreamStatusHandler } from "./types/rtmp-stream";

// Export app session modules
export * from "./app/session/modules";

// Export photo data types
export type { PhotoData } from "./types/photo-data";

// Export device state types (WebSocket-based observables)
export type { DeviceState } from "./app/session/device-state";
export { Observable } from "./utils/Observable";

// Re-export types from @mentra/types so SDK users don't need to install it separately
export type { GlassesInfo } from "@mentra/types";

/**
 * WebSocket error information
 */
export interface WebSocketError {
  code: string;
  message: string;
  details?: unknown;
}

export type { AuthenticatedRequest, AuthVariables } from "./types/index";

// Frontend authentication routes for Bun fullstack apps
export { createMentraAuthRoutes, generateFrontendToken } from "./app/webview/index";
