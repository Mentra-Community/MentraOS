// src/index.ts

export * from './token';

// Message type enums
export * from './message-types';

// Base message type
export * from './messages/base';

// Messages by direction - export everything except the conflicting type guards
export * from './messages/glasses-to-cloud';
export * from './messages/cloud-to-glasses';
export * from './messages/app-to-cloud';

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
} from './messages/cloud-to-app';

// Stream types
export * from './streams';

// Layout types
export * from './layouts';

// Dashboard types
export * from './dashboard';

// RTMP streaming types
export * from './rtmp-stream';

// Other system enums
export * from './enums';

// Core model interfaces
export * from './models';

// Session-related interfaces
export * from './user-session';

// Webhook interfaces
export * from './webhooks';

// Capability Discovery types
export * from './capabilities';


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
} from './messages/glasses-to-cloud';

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
} from './messages/cloud-to-glasses';

// From messages/app-to-cloud.ts
export {
  AppConnectionInit,
  AppSubscriptionUpdate,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  AppToCloudMessage,
  PhotoRequest
} from './messages/app-to-cloud';

// From layout.ts
export {
  TextWall,
  DoubleTextWall,
  DashboardCard,
  ReferenceCard,
  Layout,
  DisplayRequest
} from './layouts';

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
} from './messages/glasses-to-cloud';

export {
  isConnectionAck,
  isDisplayEvent,
  isAppStateChange,
  isPhotoRequest,
  isSettingsUpdate as isSettingsUpdateToGlasses,
  isStartRtmpStream,
  isStopRtmpStream,
  isKeepRtmpStreamAlive
} from './messages/cloud-to-glasses';

export {
  isAppConnectionInit,
  isAppSubscriptionUpdate,
  isDisplayRequest,
  isRtmpStreamRequest,
  isRtmpStreamStopRequest,
  isPhotoRequest as isPhotoRequestFromApp
} from './messages/app-to-cloud';

// Export setting-related types
export {
  BaseAppSetting,
  AppSetting,
  AppSettings,
  AppConfig,
  validateAppConfig,
  ToolSchema,
  ToolParameterSchema
} from './models';
// Export RTMP streaming types
export {
  VideoConfig,
  AudioConfig,
  StreamConfig,
  StreamStatusHandler
} from './rtmp-stream';

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
