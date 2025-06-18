// src/messages/tpa-to-cloud.ts

import { BaseMessage } from './base';
import { AppToCloudMessageType } from '../message-types';
import { ExtendedStreamType, StreamType } from '../streams';
import { DisplayRequest } from '../layouts';
import { DashboardContentUpdate, DashboardModeChange, DashboardSystemUpdate } from '../dashboard';
import { VideoConfig, AudioConfig, StreamConfig } from '../rtmp-stream';

/**
 * Connection initialization from TPA
 */
export interface AppConnectionInit extends BaseMessage {
  type: AppToCloudMessageType.CONNECTION_INIT;
  packageName: string;
  sessionId: string;
  apiKey: string;
}

/**
 * Subscription update from TPA
 */
export interface AppSubscriptionUpdate extends BaseMessage {
  type: AppToCloudMessageType.SUBSCRIPTION_UPDATE;
  packageName: string;
  subscriptions: ExtendedStreamType[];
}

/**
 * Photo request from TPA
 */
export interface PhotoRequest extends BaseMessage {
  type: AppToCloudMessageType.PHOTO_REQUEST;
  packageName: string;
  saveToGallery?: boolean;
}

// Video, Audio and Stream configuration interfaces are imported from '../rtmp-stream'

/**
 * RTMP stream request from TPA
 */
export interface RtmpStreamRequest extends BaseMessage {
  type: AppToCloudMessageType.RTMP_STREAM_REQUEST;
  packageName: string;
  rtmpUrl: string;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
}

/**
 * RTMP stream stop request from TPA
 */
export interface RtmpStreamStopRequest extends BaseMessage {
  type: AppToCloudMessageType.RTMP_STREAM_STOP;
  packageName: string;
  streamId?: string;  // Optional stream ID to specify which stream to stop
}

/**
 * Union type for all messages from TPAs to cloud
 */
export type AppToCloudMessage =
  | AppConnectionInit
  | AppSubscriptionUpdate
  | DisplayRequest
  | PhotoRequest
  | RtmpStreamRequest
  | RtmpStreamStopRequest
  | DashboardContentUpdate
  | DashboardModeChange
  | DashboardSystemUpdate
  // New TPA-to-TPA communication messages
  | AppBroadcastMessage
  | AppDirectMessage
  | AppUserDiscovery
  | AppRoomJoin
  | AppRoomLeave;

/**
 * Type guard to check if a message is a TPA connection init
 */
export function isAppConnectionInit(message: AppToCloudMessage): message is AppConnectionInit {
  return message.type === AppToCloudMessageType.CONNECTION_INIT;
}

/**
 * Type guard to check if a message is a TPA subscription update
 */
export function isAppSubscriptionUpdate(message: AppToCloudMessage): message is AppSubscriptionUpdate {
  return message.type === AppToCloudMessageType.SUBSCRIPTION_UPDATE;
}

/**
 * Type guard to check if a message is a TPA display request
 */
export function isDisplayRequest(message: AppToCloudMessage): message is DisplayRequest {
  return message.type === AppToCloudMessageType.DISPLAY_REQUEST;
}

/**
 * Type guard to check if a message is a TPA photo request
 */
export function isPhotoRequest(message: AppToCloudMessage): message is PhotoRequest {
  return message.type === AppToCloudMessageType.PHOTO_REQUEST;
}


/**
 * Type guard to check if a message is a dashboard content update
 */
export function isDashboardContentUpdate(message: AppToCloudMessage): message is DashboardContentUpdate {
  return message.type === AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE;
}

/**
 * Type guard to check if a message is a dashboard mode change
 */
export function isDashboardModeChange(message: AppToCloudMessage): message is DashboardModeChange {
  return message.type === AppToCloudMessageType.DASHBOARD_MODE_CHANGE;
}

/**
 * Type guard to check if a message is a dashboard system update
 */
export function isDashboardSystemUpdate(message: AppToCloudMessage): message is DashboardSystemUpdate {
  return message.type === AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE;
}

//===========================================================
// TPA-to-TPA Communication Messages
//===========================================================

/**
 * Broadcast message to all users with the same TPA active
 */
export interface AppBroadcastMessage extends BaseMessage {
  type: AppToCloudMessageType.TPA_BROADCAST_MESSAGE;
  packageName: string;
  sessionId: string;
  payload: any;
  messageId: string;
  senderUserId: string;
}

/**
 * Direct message to a specific user with the same TPA active
 */
export interface AppDirectMessage extends BaseMessage {
  type: AppToCloudMessageType.TPA_DIRECT_MESSAGE;
  packageName: string;
  sessionId: string;
  targetUserId: string;
  payload: any;
  messageId: string;
  senderUserId: string;
}

/**
 * Request to discover other users with the same TPA active
 */
export interface AppUserDiscovery extends BaseMessage {
  type: AppToCloudMessageType.TPA_USER_DISCOVERY;
  packageName: string;
  sessionId: string;
  includeUserProfiles?: boolean;
}

/**
 * Join a communication room for group messaging
 */
export interface AppRoomJoin extends BaseMessage {
  type: AppToCloudMessageType.TPA_ROOM_JOIN;
  packageName: string;
  sessionId: string;
  roomId: string;
  roomConfig?: {
    maxUsers?: number;
    isPrivate?: boolean;
    metadata?: any;
  };
}

/**
 * Leave a communication room
 */
export interface AppRoomLeave extends BaseMessage {
  type: AppToCloudMessageType.TPA_ROOM_LEAVE;
  packageName: string;
  sessionId: string;
  roomId: string;
}

/**
 * Type guard to check if a message is an RTMP stream request
 */
export function isRtmpStreamRequest(message: AppToCloudMessage): message is RtmpStreamRequest {
  return message.type === AppToCloudMessageType.RTMP_STREAM_REQUEST;
}

/**
 * Type guard to check if a message is an RTMP stream stop request
 */
export function isRtmpStreamStopRequest(message: AppToCloudMessage): message is RtmpStreamStopRequest {
  return message.type === AppToCloudMessageType.RTMP_STREAM_STOP;
}