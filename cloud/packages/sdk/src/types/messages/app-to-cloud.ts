// src/messages/app-to-cloud.ts

import {BaseMessage} from "./base"
import {AppToCloudMessageType} from "../message-types"
import {ExtendedStreamType, LocationStreamRequest} from "../streams"
import {DisplayRequest} from "../layouts"
import {DashboardContentUpdate, DashboardModeChange, DashboardSystemUpdate} from "../dashboard"
import type {VideoConfig, AudioConfig, StreamConfig} from "../rtmp-stream"
import {LedColor} from "./cloud-to-glasses"

// a subscription can now be either a simple string or our new rich object
export type SubscriptionRequest = ExtendedStreamType | LocationStreamRequest

/**
 * Connection initialization from App
 */
export interface AppConnectionInit extends BaseMessage {
  type: AppToCloudMessageType.CONNECTION_INIT
  packageName: string
  sessionId: string
  apiKey: string
}

/**
 * Subscription update from App
 */
export interface AppSubscriptionUpdate extends BaseMessage {
  type: AppToCloudMessageType.SUBSCRIPTION_UPDATE
  packageName: string
  subscriptions: SubscriptionRequest[]
}

/**
 * Photo request from App
 */
export interface PhotoRequest extends BaseMessage {
  type: AppToCloudMessageType.PHOTO_REQUEST
  packageName: string
  requestId: string // SDK-generated request ID to track the request
  saveToGallery?: boolean
  customWebhookUrl?: string // Custom webhook URL to override TPA's default
  authToken?: string // Auth token for custom webhook authentication
  /** Desired photo size sent by App. Defaults to 'medium' if omitted. */
  size?: "small" | "medium" | "large" | "full"
  /** Image compression level: none, medium, or heavy. Defaults to none. */
  compress?: "none" | "medium" | "heavy"
}

/**
 * RGB LED control request from App
 */
export interface RgbLedControlRequest extends BaseMessage {
  type: AppToCloudMessageType.RGB_LED_CONTROL
  packageName: string
  requestId: string // SDK-generated request ID to track the request
  action: "on" | "off" // Only low-level on/off actions
  color?: LedColor // LED color name
  ontime?: number // LED on duration in ms
  offtime?: number // LED off duration in ms
  count?: number // Number of on/off cycles
}

// Video, Audio and Stream configuration interfaces are imported from '../rtmp-stream'

/**
 * RTMP stream request from App
 */
export interface RtmpStreamRequest extends BaseMessage {
  type: AppToCloudMessageType.RTMP_STREAM_REQUEST
  packageName: string
  rtmpUrl: string
  video?: VideoConfig
  audio?: AudioConfig
  stream?: StreamConfig
}

/**
 * RTMP stream stop request from App
 */
export interface RtmpStreamStopRequest extends BaseMessage {
  type: AppToCloudMessageType.RTMP_STREAM_STOP
  packageName: string
  streamId?: string // Optional stream ID to specify which stream to stop
}

// defines the structure for our new on-demand location poll command
export interface AppLocationPollRequest extends BaseMessage {
  type: AppToCloudMessageType.LOCATION_POLL_REQUEST
  packageName: string
  sessionId: string
  accuracy: string
  correlationId: string
}

/**
 * Re-stream destination for managed streams
 */
export interface RestreamDestination {
  /** RTMP URL like rtmp://youtube.com/live/STREAM-KEY */
  url: string
  /** Optional friendly name like "YouTube" or "Twitch" */
  name?: string
}

/**
 * Managed RTMP stream request from App
 * The cloud handles the RTMP endpoint and returns HLS/DASH URLs
 */
export interface ManagedStreamRequest extends BaseMessage {
  type: AppToCloudMessageType.MANAGED_STREAM_REQUEST
  packageName: string
  quality?: "720p" | "1080p"
  enableWebRTC?: boolean
  video?: VideoConfig
  audio?: AudioConfig
  stream?: StreamConfig
  /** Optional RTMP destinations to re-stream to (YouTube, Twitch, etc) */
  restreamDestinations?: RestreamDestination[]
}

/**
 * Managed RTMP stream stop request from App
 */
export interface ManagedStreamStopRequest extends BaseMessage {
  type: AppToCloudMessageType.MANAGED_STREAM_STOP
  packageName: string
}

/**
 * Stream status check request from App
 * Checks if there are any existing streams (managed or unmanaged) for the current user
 */
export interface StreamStatusCheckRequest extends BaseMessage {
  type: AppToCloudMessageType.STREAM_STATUS_CHECK
  packageName: string
  sessionId: string
}

/**
 * Audio play request from App
 */
export interface AudioPlayRequest extends BaseMessage {
  type: AppToCloudMessageType.AUDIO_PLAY_REQUEST
  packageName: string
  requestId: string // SDK-generated request ID to track the request
  audioUrl: string // URL to audio file for download and play
  volume?: number // Volume level 0.0-1.0, defaults to 1.0
  stopOtherAudio?: boolean // Whether to stop other audio playback, defaults to true
  /**
   * Track ID for audio playback (defaults to 0)
   * - 0: speaker (default audio playback)
   * - 1: app_audio (app-specific audio)
   * - 2: tts (text-to-speech audio)
   * Use different track IDs to play multiple audio streams simultaneously (mixing)
   */
  trackId?: number
}

/**
 * Audio stop request from App
 */
export interface AudioStopRequest extends BaseMessage {
  type: AppToCloudMessageType.AUDIO_STOP_REQUEST
  packageName: string
  /**
   * Track ID to stop (optional)
   * 0: speaker (default audio playback)
   * 1: app_audio (app-specific audio)
   * 2: tts (text-to-speech audio)
   * If omitted, stops all tracks
   */
  trackId?: number
  sessionId?: string // Session ID for routing
}

/**
 * WiFi setup request from App
 */
export interface RequestWifiSetup extends BaseMessage {
  type: AppToCloudMessageType.REQUEST_WIFI_SETUP
  packageName: string
  sessionId: string
  reason?: string
}

/**
 * Union type for all messages from Apps to cloud
 */
export type AppToCloudMessage =
  | AppConnectionInit
  | AppSubscriptionUpdate
  | AppLocationPollRequest
  | DisplayRequest
  | PhotoRequest
  | RgbLedControlRequest
  | AudioPlayRequest
  | AudioStopRequest
  | RtmpStreamRequest
  | RtmpStreamStopRequest
  | ManagedStreamRequest
  | ManagedStreamStopRequest
  | StreamStatusCheckRequest
  | DashboardContentUpdate
  | DashboardModeChange
  | DashboardSystemUpdate
  | RequestWifiSetup
  // New App-to-App communication messages
  | AppBroadcastMessage
  | AppDirectMessage
  | AppUserDiscovery
  | AppRoomJoin
  | AppRoomLeave

/**
 * Type guard to check if a message is a App connection init
 */
export function isAppConnectionInit(message: AppToCloudMessage): message is AppConnectionInit {
  return message.type === AppToCloudMessageType.CONNECTION_INIT
}

/**
 * Type guard to check if a message is a App subscription update
 */
export function isAppSubscriptionUpdate(message: AppToCloudMessage): message is AppSubscriptionUpdate {
  return message.type === AppToCloudMessageType.SUBSCRIPTION_UPDATE
}

/**
 * Type guard to check if a message is a App display request
 */
export function isDisplayRequest(message: AppToCloudMessage): message is DisplayRequest {
  return message.type === AppToCloudMessageType.DISPLAY_REQUEST
}

/**
 * Type guard to check if a message is a App photo request
 */
export function isPhotoRequest(message: AppToCloudMessage): message is PhotoRequest {
  return message.type === AppToCloudMessageType.PHOTO_REQUEST
}

/**
 * Type guard to check if a message is a RGB LED control request
 */
export function isRgbLedControlRequest(message: AppToCloudMessage): message is RgbLedControlRequest {
  return message.type === AppToCloudMessageType.RGB_LED_CONTROL
}

/**
 * Type guard to check if a message is a App audio play request
 */
export function isAudioPlayRequest(message: AppToCloudMessage): message is AudioPlayRequest {
  return message.type === AppToCloudMessageType.AUDIO_PLAY_REQUEST
}

/**
 * Type guard to check if a message is a App audio stop request
 */
export function isAudioStopRequest(message: AppToCloudMessage): message is AudioStopRequest {
  return message.type === AppToCloudMessageType.AUDIO_STOP_REQUEST
}

/**
 * Type guard to check if a message is a dashboard content update
 */
export function isDashboardContentUpdate(message: AppToCloudMessage): message is DashboardContentUpdate {
  return message.type === AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE
}

/**
 * Type guard to check if a message is a dashboard mode change
 */
export function isDashboardModeChange(message: AppToCloudMessage): message is DashboardModeChange {
  return message.type === AppToCloudMessageType.DASHBOARD_MODE_CHANGE
}

/**
 * Type guard to check if a message is a dashboard system update
 */
export function isDashboardSystemUpdate(message: AppToCloudMessage): message is DashboardSystemUpdate {
  return message.type === AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE
}

/**
 * Type guard to check if a message is a managed stream request
 */
export function isManagedStreamRequest(message: AppToCloudMessage): message is ManagedStreamRequest {
  return message.type === AppToCloudMessageType.MANAGED_STREAM_REQUEST
}

/**
 * Type guard to check if a message is a managed stream stop request
 */
export function isManagedStreamStopRequest(message: AppToCloudMessage): message is ManagedStreamStopRequest {
  return message.type === AppToCloudMessageType.MANAGED_STREAM_STOP
}

//===========================================================
// App-to-App Communication Messages
//===========================================================

/**
 * Broadcast message to all users with the same App active
 */
export interface AppBroadcastMessage extends BaseMessage {
  type: AppToCloudMessageType.APP_BROADCAST_MESSAGE
  packageName: string
  sessionId: string
  payload: any
  messageId: string
  senderUserId: string
}

/**
 * Direct message to a specific user with the same App active
 */
export interface AppDirectMessage extends BaseMessage {
  type: AppToCloudMessageType.APP_DIRECT_MESSAGE
  packageName: string
  sessionId: string
  targetUserId: string
  payload: any
  messageId: string
  senderUserId: string
}

/**
 * Request to discover other users with the same App active
 */
export interface AppUserDiscovery extends BaseMessage {
  type: AppToCloudMessageType.APP_USER_DISCOVERY
  packageName: string
  sessionId: string
  includeUserProfiles?: boolean
}

/**
 * Join a communication room for group messaging
 */
export interface AppRoomJoin extends BaseMessage {
  type: AppToCloudMessageType.APP_ROOM_JOIN
  packageName: string
  sessionId: string
  roomId: string
  roomConfig?: {
    maxUsers?: number
    isPrivate?: boolean
    metadata?: any
  }
}

/**
 * Leave a communication room
 */
export interface AppRoomLeave extends BaseMessage {
  type: AppToCloudMessageType.APP_ROOM_LEAVE
  packageName: string
  sessionId: string
  roomId: string
}

/**
 * Type guard to check if a message is an RTMP stream request
 */
export function isRtmpStreamRequest(message: AppToCloudMessage): message is RtmpStreamRequest {
  return message.type === AppToCloudMessageType.RTMP_STREAM_REQUEST
}

/**
 * Type guard to check if a message is an RTMP stream stop request
 */
export function isRtmpStreamStopRequest(message: AppToCloudMessage): message is RtmpStreamStopRequest {
  return message.type === AppToCloudMessageType.RTMP_STREAM_STOP
}
