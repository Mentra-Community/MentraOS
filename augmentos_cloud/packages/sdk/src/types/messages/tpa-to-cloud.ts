// src/messages/tpa-to-cloud.ts

import { BaseMessage } from './base';
import { TpaToCloudMessageType } from '../message-types';
import { ExtendedStreamType, StreamType } from '../streams';
import { DisplayRequest } from '../layouts';
import { DashboardContentUpdate, DashboardModeChange, DashboardSystemUpdate } from '../dashboard';
import { VideoConfig, AudioConfig, StreamConfig } from '../rtmp-stream';

// [NEW TYPE DEFINITION]
// Defines a specific object for our tiered location stream requests.
export interface LocationStreamRequest {
  stream: 'location_stream';
  rate: 'standard' | 'high' | 'realtime' | 'tenMeters' | 'hundredMeters' | 'kilometer' | 'threeKilometers' | 'reduced';
}

// [UPDATED TYPE DEFINITION]
// A subscription can now be a generic stream type OR our specific location request object.
export type SubscriptionRequest = ExtendedStreamType | LocationStreamRequest;

/**
 * Connection initialization from TPA
 */
export interface TpaConnectionInit extends BaseMessage {
  type: TpaToCloudMessageType.CONNECTION_INIT;
  packageName: string;
  sessionId: string;
  apiKey: string;
}

/**
 * Subscription update from TPA
 */
export interface TpaSubscriptionUpdate extends BaseMessage {
  type: TpaToCloudMessageType.SUBSCRIPTION_UPDATE;
  packageName: string;
  subscriptions: SubscriptionRequest[];
}

/**
 * Photo request from TPA
 */
export interface PhotoRequest extends BaseMessage {
  type: TpaToCloudMessageType.PHOTO_REQUEST;
  packageName: string;
  saveToGallery?: boolean;
}

// Video, Audio and Stream configuration interfaces are imported from '../rtmp-stream'

/**
 * RTMP stream request from TPA
 */
export interface RtmpStreamRequest extends BaseMessage {
  type: TpaToCloudMessageType.RTMP_STREAM_REQUEST;
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
  type: TpaToCloudMessageType.RTMP_STREAM_STOP;
  packageName: string;
  streamId?: string;  // Optional stream ID to specify which stream to stop
}

// Interface for location poll request from TPA
export interface TpaLocationPollRequest extends BaseMessage {
  type: TpaToCloudMessageType.LOCATION_POLL_REQUEST;
  packageName: string;
  sessionId: string;
  accuracy: string;
}

/**
 * Union type for all messages from TPAs to cloud
 */
export type TpaToCloudMessage =
  | TpaConnectionInit
  | TpaSubscriptionUpdate
  | TpaLocationPollRequest
  | DisplayRequest
  | PhotoRequest
  | RtmpStreamRequest
  | RtmpStreamStopRequest
  | DashboardContentUpdate
  | DashboardModeChange
  | DashboardSystemUpdate
  // New TPA-to-TPA communication messages
  | TpaBroadcastMessage
  | TpaDirectMessage
  | TpaUserDiscovery
  | TpaRoomJoin
  | TpaRoomLeave;

/**
 * Type guard to check if a message is a TPA connection init
 */
export function isTpaConnectionInit(message: TpaToCloudMessage): message is TpaConnectionInit {
  return message.type === TpaToCloudMessageType.CONNECTION_INIT;
}

/**
 * Type guard to check if a message is a TPA subscription update
 */
export function isTpaSubscriptionUpdate(message: TpaToCloudMessage): message is TpaSubscriptionUpdate {
  return message.type === TpaToCloudMessageType.SUBSCRIPTION_UPDATE;
}

/**
 * Type guard to check if a message is a TPA display request
 */
export function isDisplayRequest(message: TpaToCloudMessage): message is DisplayRequest {
  return message.type === TpaToCloudMessageType.DISPLAY_REQUEST;
}

/**
 * Type guard to check if a message is a TPA photo request
 */
export function isPhotoRequest(message: TpaToCloudMessage): message is PhotoRequest {
  return message.type === TpaToCloudMessageType.PHOTO_REQUEST;
}


/**
 * Type guard to check if a message is a dashboard content update
 */
export function isDashboardContentUpdate(message: TpaToCloudMessage): message is DashboardContentUpdate {
  return message.type === TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE;
}

/**
 * Type guard to check if a message is a dashboard mode change
 */
export function isDashboardModeChange(message: TpaToCloudMessage): message is DashboardModeChange {
  return message.type === TpaToCloudMessageType.DASHBOARD_MODE_CHANGE;
}

/**
 * Type guard to check if a message is a dashboard system update
 */
export function isDashboardSystemUpdate(message: TpaToCloudMessage): message is DashboardSystemUpdate {
  return message.type === TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE;
}

//===========================================================
// TPA-to-TPA Communication Messages
//===========================================================

/**
 * Broadcast message to all users with the same TPA active
 */
export interface TpaBroadcastMessage extends BaseMessage {
  type: TpaToCloudMessageType.TPA_BROADCAST_MESSAGE;
  packageName: string;
  sessionId: string;
  payload: any;
  messageId: string;
  senderUserId: string;
}

/**
 * Direct message to a specific user with the same TPA active
 */
export interface TpaDirectMessage extends BaseMessage {
  type: TpaToCloudMessageType.TPA_DIRECT_MESSAGE;
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
export interface TpaUserDiscovery extends BaseMessage {
  type: TpaToCloudMessageType.TPA_USER_DISCOVERY;
  packageName: string;
  sessionId: string;
  includeUserProfiles?: boolean;
}

/**
 * Join a communication room for group messaging
 */
export interface TpaRoomJoin extends BaseMessage {
  type: TpaToCloudMessageType.TPA_ROOM_JOIN;
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
export interface TpaRoomLeave extends BaseMessage {
  type: TpaToCloudMessageType.TPA_ROOM_LEAVE;
  packageName: string;
  sessionId: string;
  roomId: string;
}

/**
 * Type guard to check if a message is an RTMP stream request
 */
export function isRtmpStreamRequest(message: TpaToCloudMessage): message is RtmpStreamRequest {
  return message.type === TpaToCloudMessageType.RTMP_STREAM_REQUEST;
}

/**
 * Type guard to check if a message is an RTMP stream stop request
 */
export function isRtmpStreamStopRequest(message: TpaToCloudMessage): message is RtmpStreamStopRequest {
  return message.type === TpaToCloudMessageType.RTMP_STREAM_STOP;
}