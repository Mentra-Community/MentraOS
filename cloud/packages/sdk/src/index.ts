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

// Export cloud-to-app but exclude the conflicting type guards
export {
  // Types
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
  // Re-export the cloud-to-app versions of these type guards since they're the ones
  // that should be used when dealing with CloudToAppMessage types
  isPhotoResponse as isPhotoResponseFromCloud,
  isRgbLedControlResponse as isRgbLedControlResponseFromCloud,
  isRtmpStreamStatus as isRtmpStreamStatusFromCloud,
} from "./types/messages/cloud-to-app";

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

// Re-export common types for convenience
// This allows developers to import commonly used types directly from the package root
// without having to know exactly which file they come from

// From messages/glasses-to-cloud.ts
export {
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
  PhotoErrorCode,
  PhotoStage,
  ConnectionState,
  PhotoErrorDetails,
  RtmpStreamStatus,
  KeepAliveAck,
} from "./types/messages/glasses-to-cloud";

// From messages/cloud-to-glasses.ts
export {
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
export {
  AppConnectionInit,
  AppSubscriptionUpdate,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  AppToCloudMessage,
  PhotoRequest,
  RgbLedControlRequest,
} from "./types/messages/app-to-cloud";

// From layout.ts
export {
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
export {
  BaseAppSetting,
  AppSetting,
  AppSettings,
  AppConfig,
  validateAppConfig,
  ToolSchema,
  ToolParameterSchema,
  HardwareRequirement,
} from "./types/models";

// Export RTMP streaming types
export { VideoConfig, AudioConfig, StreamConfig, StreamStatusHandler } from "./types/rtmp-stream";

// Export app session modules
export * from "./app/session/modules";

// Export photo data types
export { PhotoData } from "./types/photo-data";

// Export device state types (WebSocket-based observables)
export { DeviceState } from "./app/session/device-state";
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

export { AuthenticatedRequest } from "./types/index";
