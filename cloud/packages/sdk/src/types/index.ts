// src/index.ts

export * from "./token"

// Message type enums
export * from "./message-types"

// Base message type
export * from "./messages/base"

// Messages by direction - export everything except the conflicting type guards
export * from "./messages/glasses-to-cloud"
export * from "./messages/cloud-to-glasses"

// Export from app-to-cloud excluding isPhotoRequest which conflicts with cloud-to-glasses
export {
  // Types
  SubscriptionRequest,
  AppConnectionInit,
  AppSubscriptionUpdate,
  PhotoRequest,
  RgbLedControlRequest,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  AppLocationPollRequest,
  RestreamDestination,
  ManagedStreamRequest,
  ManagedStreamStopRequest,
  StreamStatusCheckRequest,
  AudioPlayRequest,
  AudioStopRequest,
  AppToCloudMessage,
  AppBroadcastMessage,
  AppDirectMessage,
  AppUserDiscovery,
  AppRoomJoin,
  AppRoomLeave,
  RequestWifiSetup,
  OwnershipReleaseMessage,
  // Type guards - all except isPhotoRequest
  isAppConnectionInit,
  isAppSubscriptionUpdate,
  isDisplayRequest,
  isRgbLedControlRequest,
  isAudioPlayRequest,
  isAudioStopRequest,
  isDashboardContentUpdate,
  isDashboardModeChange,
  isDashboardSystemUpdate,
  isManagedStreamRequest,
  isManagedStreamStopRequest,
  isRtmpStreamRequest,
  isRtmpStreamStopRequest,
  isOwnershipRelease,
  // Export with alias to avoid conflict
  isPhotoRequest as isPhotoRequestFromApp,
} from "./messages/app-to-cloud"

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
  AudioPlayResponse,
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
  // Type guards (excluding isPhotoResponse and isRtmpStreamStatus which conflict)
  isAppConnectionAck,
  isAppConnectionError,
  isAppStopped,
  isSettingsUpdate,
  isCapabilitiesUpdate,
  isDataStream,
  isAudioChunk,
  isAudioPlayResponse,
  isDashboardModeChanged,
  isDashboardAlwaysOnChanged,
  isManagedStreamStatus,
  isStreamStatusCheckResponse,
  // Re-export the cloud-to-app versions of these type guards since they're the ones
  // that should be used when dealing with CloudToAppMessage types
  isPhotoResponse as isPhotoResponseFromCloud,
  isRtmpStreamStatus as isRtmpStreamStatusFromCloud,
  isRgbLedControlResponse as isRgbLedControlResponseFromCloud,
} from "./messages/cloud-to-app"

// Stream types
export * from "./streams"

// Layout types
export * from "./layouts"

// Dashboard types
export * from "./dashboard"

// RTMP streaming types
export * from "./rtmp-stream"

// Other system enums
export * from "./enums"

// Core model interfaces
export * from "./models"

// Webhook interfaces
export * from "./webhooks"

// Capability Discovery types
export * from "./capabilities"

// Photo data types
export * from "./photo-data"

/**
 * WebSocket error information
 */
export interface WebSocketError {
  code: string
  message: string
  details?: unknown
}

import type {Request} from "express"
import type {AppSession} from "../app/session"

export interface AuthenticatedRequest extends Request {
  authUserId?: string
  activeSession: AppSession | null
}
