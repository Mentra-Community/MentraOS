// src/sessions.ts - Session-related interfaces

import { WebSocket } from 'ws';
import { AppI, AppSettings, TranscriptI } from './models';
import { AppState, Language } from './enums';
import { DisplayRequest, Layout } from './layouts';
import { Transform } from 'stream';
import {
  ConversationTranscriber,
  PushAudioInputStream,
} from 'microsoft-cognitiveservices-speech-sdk';
import { ExtendedStreamType, StreamType } from './streams';
import winston from 'winston';
import pino from 'pino';

/**
 * Session for an application
 */
export interface AppSessionI {
  userId: string;
  packageName: string;
  state: AppState;
  subscriptions: string[];
  translateToLanguages?: Language[];
  translationConfig?: {
    preserveFormatting?: boolean;
    profanityFilter?: boolean;
    contextLength?: number;
  };
  endedAt?: Date;
  disconnectedAt?: Date;
  websocket?: WebSocket;
}

/**
 * Audio processor configuration
 */
export interface AudioProcessorConfig {
  threshold: number;      // dB threshold where compression begins (-24 default)
  ratio: number;         // Compression ratio (3:1 default)
  attack: number;        // Attack time in ms (5ms default)
  release: number;       // Release time in ms (50ms default)
  gainDb: number;        // Output gain in dB (16 default)
  sampleRate: number;    // Sample rate (default 16000)
  channels: number;      // Number of channels (1 for mono)
}

/**
 * Audio processor interface
 */
export interface AudioProcessorI extends Transform {}

/**
 * The display manager interface
 */
export interface DisplayManagerI {
  handleDisplayEvent(displayRequest: DisplayRequest, userSession: UserSession): boolean;
  handleAppStart(packageName: string, userSession: UserSession): void;
  handleAppStop(packageName: string, userSession: UserSession): void;
}

/**
 * Currently active display
 */
export interface ActiveDisplay {
  displayRequest: DisplayRequest;
  startedAt: Date;
  expiresAt?: Date;  // When to auto-clear this display
}

/**
 * User session with glasses client
 */
export interface UserSession {
  sessionId: string;
  userId: string;
  startTime: Date;
  disconnectedAt: Date | null;

  // Logger.
  logger: pino.Logger;

  // App Sessions and App State
  installedApps: AppI[];
  activeAppSessions: string[];
  loadingApps: Set<string>;
  appSubscriptions: Map<string, ExtendedStreamType[]> | Object; // packageName -> subscriptions;
  appConnections: Map<string, WebSocket>; // packageName -> websocket connection for the system app / TPA;

  displayManager: DisplayManagerI;

  websocket: WebSocket;
  transcript: TranscriptI

  // Azure Speech Service handles
  pushStream?: PushAudioInputStream;
  recognizer?: ConversationTranscriber;
  isTranscribing: boolean;  // New flag to track transcription state
  lastAudioTimestamp?: number;  // Last audio timestamp for debugging
  isGracefullyClosing?: boolean;  // Flag to track if the session is closing gracefully
  
  // Pre-initialization audio buffer
  bufferedAudio: ArrayBufferLike[];

  // Audio Processing
  audioProcessor?: AudioProcessorI;  // Optional audio processor instance
  isAudioProcessing?: boolean;      // Flag to track audio processing state

  // TODO:
  whatToStream: ExtendedStreamType[];
}

/**
 * App session within a user session
 */
export interface AppSession {
  packageName: string;
  userId: string;
  subscriptions: StreamType[];
  settings: AppSettings;
  websocket?: WebSocket;
  state: AppState;
  startTime: Date;
  lastActiveTime: Date;
}