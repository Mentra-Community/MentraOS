// src/index.ts

export * from './types/token';

// Message type enums
export * from './types/message-types';

// Base message type
export * from './types/messages/base';

// Messages by direction - export everything except the conflicting type guards
export * from './types/messages/glasses-to-cloud';
export * from './types/messages/cloud-to-glasses';
export * from './types/messages/app-to-cloud';

// Export cloud-to-app but exclude the conflicting type guards
export {
  // Types
  AppConnectionAck,
  AppConnectionError,
  AppStopped,
  SettingsUpdate as AppSettingsUpdate,  // Alias to avoid conflict with cloud-to-glasses SettingsUpdate
  DataStream,
  CloudToAppMessage,
  TranslationData,
  ToolCall,
  StandardConnectionError,
  CustomMessage,
  MentraosSettingsUpdate,
  TranscriptionData,
  AudioChunk,
  PermissionError,
  PermissionErrorDetail,
  // Type guards (excluding isPhotoResponse and isRtmpStreamStatus which conflict)
  isAppConnectionAck,
  isAppConnectionError,
  isAppStopped,
  isSettingsUpdate,
  isDataStream,
  isAudioChunk,
  isDashboardModeChanged,
  isDashboardAlwaysOnChanged,
  // Re-export the cloud-to-app versions of these type guards since they're the ones
  // that should be used when dealing with CloudToAppMessage types
  isPhotoResponse as isPhotoResponseFromCloud,
  isRtmpStreamStatus as isRtmpStreamStatusFromCloud
} from './types/messages/cloud-to-app';

// Stream types
export * from './types/streams';

// Layout types
export * from './types/layouts';

// Dashboard types
export * from './types/dashboard';

// RTMP streaming types
export * from './types/rtmp-stream';

// Other system enums
export * from './types/enums';

// Core model interfaces
export * from './types/models';

// Session-related interfaces
export * from './types/user-session';

// Webhook interfaces
export * from './types/webhooks';

// Capability Discovery types
export * from './types/capabilities';

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
  GlassesBatteryUpdate,
  PhoneBatteryUpdate,
  GlassesConnectionState,
  LocationUpdate,
  CalendarEvent,
  Vad,
  PhoneNotification,
  NotificationDismissed,
  StartApp,
  StopApp,
  ConnectionInit,
  DashboardState,
  OpenDashboard,
  GlassesToCloudMessage,
  PhotoResponse,
  RtmpStreamStatus,
  KeepAliveAck
} from './types/messages/glasses-to-cloud';

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
  SettingsUpdate,
  StartRtmpStream,
  StopRtmpStream,
  KeepRtmpStreamAlive
} from './types/messages/cloud-to-glasses';

// From messages/app-to-cloud.ts
export {
  AppConnectionInit,
  AppSubscriptionUpdate,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  AppToCloudMessage,
  PhotoRequest
} from './types/messages/app-to-cloud';

// From layout.ts
export {
  TextWall,
  DoubleTextWall,
  DashboardCard,
  ReferenceCard,
  Layout,
  DisplayRequest
} from './types/layouts';

// Type guards - re-export the most commonly used ones for convenience
export {
  isButtonPress,
  isHeadPosition,
  isConnectionInit,
  isStartApp,
  isStopApp,
  isPhotoResponse as isPhotoResponseFromGlasses,
  isRtmpStreamStatus as isRtmpStreamStatusFromGlasses,
  isKeepAliveAck
} from './types/messages/glasses-to-cloud';

export {
  isConnectionAck,
  isDisplayEvent,
  isAppStateChange,
  isPhotoRequest,
  isSettingsUpdate as isSettingsUpdateToGlasses,
  isStartRtmpStream,
  isStopRtmpStream,
  isKeepRtmpStreamAlive
} from './types/messages/cloud-to-glasses';

export {
  isAppConnectionInit,
  isAppSubscriptionUpdate,
  isDisplayRequest,
  isRtmpStreamRequest,
  isRtmpStreamStopRequest,
  isPhotoRequest as isPhotoRequestFromApp
} from './types/messages/app-to-cloud';

// Export setting-related types
export {
  BaseAppSetting,
  AppSetting,
  AppSettings,
  AppConfig,
  validateAppConfig,
  ToolSchema,
  ToolParameterSchema
} from './types/models';

// Export RTMP streaming types
export {
  VideoConfig,
  AudioConfig,
  StreamConfig,
  StreamStatusHandler
} from './types/rtmp-stream';

/**
 * WebSocket error information
 */
export interface WebSocketError {
  code: string;
  message: string;
  details?: unknown;
}

import { Request } from 'express';
export interface AuthenticatedRequest extends Request {
  authUserId?: string;
}
