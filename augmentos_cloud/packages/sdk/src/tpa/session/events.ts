/**
 * 🎮 Event Manager Module
 */
import EventEmitter from 'events';
import {
  StreamType,
  ExtendedStreamType,
  AppSettings,
  WebSocketError,
  // Event data types
  ButtonPress,
  HeadPosition,
  PhoneNotification,
  TranscriptionData,
  TranslationData,
  GlassesBatteryUpdate,
  PhoneBatteryUpdate,
  GlassesConnectionState,
  LocationUpdate,
  Vad,
  NotificationDismissed,
  AudioChunk,
  CalendarEvent,
  VpsCoordinates,
  // Language stream helpers
  createTranscriptionStream,
  isValidLanguageCode,
  createTranslationStream,
  CustomMessage,
  RtmpStreamStatus,
  PhotoTaken
} from '../../types';
import { DashboardMode } from '../../types/dashboard';
import { PermissionError, PermissionErrorDetail } from '../../types/messages/cloud-to-tpa';

/** 🎯 Type-safe event handler function */
type Handler<T> = (data: T) => void;

/** 🔄 System events not tied to streams */
interface SystemEvents {
  'connected': AppSettings | undefined;
  'disconnected': string | {
    message: string;     // Human-readable close message
    code: number;        // WebSocket close code (1000 = normal)
    reason: string;      // Reason provided by server
    wasClean: boolean;   // Whether this was a clean closure
    permanent?: boolean; // Whether this is a permanent disconnection (no more reconnection attempts)
  };
  'error': WebSocketError | Error;
  'settings_update': AppSettings;
  'dashboard_mode_change': { mode: DashboardMode | 'none' };
  'dashboard_always_on_change': { enabled: boolean };
  'custom_message': CustomMessage;
  'permission_error': {
    message: string;
    details: PermissionErrorDetail[];
    timestamp?: Date;
  };
  'permission_denied': {
    stream: string;
    requiredPermission: string;
    message: string;
  };
}

/** 📡 All possible event types */
type EventType = ExtendedStreamType | keyof SystemEvents;

/** 📦 Map of stream types to their data types */
export interface StreamDataTypes {
  [StreamType.BUTTON_PRESS]: ButtonPress;
  [StreamType.HEAD_POSITION]: HeadPosition;
  [StreamType.PHONE_NOTIFICATION]: PhoneNotification;
  [StreamType.TRANSCRIPTION]: TranscriptionData;
  [StreamType.TRANSLATION]: TranslationData;
  [StreamType.GLASSES_BATTERY_UPDATE]: GlassesBatteryUpdate;
  [StreamType.PHONE_BATTERY_UPDATE]: PhoneBatteryUpdate;
  [StreamType.GLASSES_CONNECTION_STATE]: GlassesConnectionState;
  [StreamType.LOCATION_UPDATE]: LocationUpdate;
  [StreamType.CALENDAR_EVENT]: CalendarEvent;
  [StreamType.VAD]: Vad;
  [StreamType.NOTIFICATION_DISMISSED]: NotificationDismissed;
  [StreamType.AUDIO_CHUNK]: AudioChunk;
  [StreamType.VIDEO]: ArrayBuffer;
  [StreamType.RTMP_STREAM_STATUS]: RtmpStreamStatus; // Using any for now, should be StreamStatus
  [StreamType.VPS_COORDINATES]: VpsCoordinates;
  [StreamType.PHOTO_TAKEN]: PhotoTaken;
  [StreamType.OPEN_DASHBOARD]: never;
  [StreamType.START_APP]: never;
  [StreamType.STOP_APP]: never;
  [StreamType.ALL]: never;
  [StreamType.WILDCARD]: never;
}

/** 📦 Data type for an event */
export type EventData<T extends EventType> = T extends keyof StreamDataTypes
  ? StreamDataTypes[T]
  : T extends keyof SystemEvents
    ? SystemEvents[T]
    : T extends string
      ? T extends `${StreamType.TRANSCRIPTION}:${string}`
        ? TranscriptionData
        : T extends `${StreamType.TRANSLATION}:${string}`
          ? TranslationData
          : never
      : never;

export class EventManager {
  private emitter: EventEmitter;
  private handlers: Map<EventType, Set<Handler<unknown>>>;
  private lastLanguageTranscriptioCleanupHandler: () => void;
  private lastLanguageTranslationCleanupHandler: () => void;

  constructor(
    private subscribe: (type: ExtendedStreamType) => void,
    private unsubscribe: (type: ExtendedStreamType) => void
  ) {
    this.emitter = new EventEmitter();
    this.handlers = new Map();
    this.lastLanguageTranscriptioCleanupHandler = () => {};
    this.lastLanguageTranslationCleanupHandler = () => {};
  }

  // Convenience handlers for common event types

  onTranscription(handler: Handler<TranscriptionData>) {
    // Default to en-US when using the generic transcription handler
    return this.addHandler(createTranscriptionStream('en-US'), handler);
  }

  /**
   * 🎤 Listen for transcription events in a specific language
   * @param language - Language code (e.g., "en-US")
   * @param handler - Function to handle transcription data
   * @returns Cleanup function to remove the handler
   * @throws Error if language code is invalid
   */
  onTranscriptionForLanguage(language: string, handler: Handler<TranscriptionData>): () => void {
    if (!isValidLanguageCode(language)) {
      throw new Error(`Invalid language code: ${language}`);
    }
    this.lastLanguageTranscriptioCleanupHandler();

    // console.log(`((())) onTranscriptionForLanguage: ${language}`);

    const streamType = createTranscriptionStream(language);
    // console.log(`((())) streamType: ${streamType}`);

    // console.log(`^^^^^^^ handler: ${handler.toString()}`);
    this.lastLanguageTranscriptioCleanupHandler = this.addHandler(streamType, handler);
    return this.lastLanguageTranscriptioCleanupHandler;
  }

  /**
   * 🌐 Listen for translation events for a specific language pair
   * @param sourceLanguage - Source language code (e.g., "es-ES")
   * @param targetLanguage - Target language code (e.g., "en-US")
   * @param handler - Function to handle translation data
   * @returns Cleanup function to remove the handler
   * @throws Error if language codes are invalid
   */
  ontranslationForLanguage(sourceLanguage: string, targetLanguage: string, handler: Handler<TranslationData>): () => void {
    if (!isValidLanguageCode(sourceLanguage)) {
      throw new Error(`Invalid source language code: ${sourceLanguage}`);
    }
    if (!isValidLanguageCode(targetLanguage)) {
      throw new Error(`Invalid target language code: ${targetLanguage}`);
    }

    this.lastLanguageTranslationCleanupHandler();
    const streamType = createTranslationStream(sourceLanguage, targetLanguage);
    this.lastLanguageTranslationCleanupHandler = this.addHandler(streamType, handler);

    return this.lastLanguageTranslationCleanupHandler;
  }

  onHeadPosition(handler: Handler<HeadPosition>) {
    return this.addHandler(StreamType.HEAD_POSITION, handler);
  }

  onButtonPress(handler: Handler<ButtonPress>) {
    return this.addHandler(StreamType.BUTTON_PRESS, handler);
  }

  onPhoneNotifications(handler: Handler<PhoneNotification>) {
    return this.addHandler(StreamType.PHONE_NOTIFICATION, handler);
  }

  onGlassesBattery(handler: Handler<GlassesBatteryUpdate>) {
    return this.addHandler(StreamType.GLASSES_BATTERY_UPDATE, handler);
  }

  onPhoneBattery(handler: Handler<PhoneBatteryUpdate>) {
    return this.addHandler(StreamType.PHONE_BATTERY_UPDATE, handler);
  }

  onVoiceActivity(handler: Handler<Vad>) {
    return this.addHandler(StreamType.VAD, handler);
  }

  onLocation(handler: Handler<LocationUpdate>) {
    return this.addHandler(StreamType.LOCATION_UPDATE, handler);
  }

  onCalendarEvent(handler: Handler<CalendarEvent>) {
    return this.addHandler(StreamType.CALENDAR_EVENT, handler);
  }

  /**
   * 🎤 Listen for audio chunk data
   * @param handler - Function to handle audio chunks
   * @returns Cleanup function to remove the handler
   */
  onAudioChunk(handler: Handler<AudioChunk>) {
    return this.addHandler(StreamType.AUDIO_CHUNK, handler);
  }

  // System event handlers

  onConnected(handler: Handler<SystemEvents['connected']>) {
    this.emitter.on('connected', handler);
    return () => this.emitter.off('connected', handler);
  }

  onDisconnected(handler: Handler<SystemEvents['disconnected']>) {
    this.emitter.on('disconnected', handler);
    return () => this.emitter.off('disconnected', handler);
  }

  onError(handler: Handler<SystemEvents['error']>) {
    this.emitter.on('error', handler);
    return () => this.emitter.off('error', handler);
  }

  onSettingsUpdate(handler: Handler<SystemEvents['settings_update']>) {
    this.emitter.on('settings_update', handler);
    return () => this.emitter.off('settings_update', handler);
  }

  /**
   * 🌐 Listen for dashboard mode changes
   * @param handler - Function to handle dashboard mode changes
   * @returns Cleanup function to remove the handler
   */
  onDashboardModeChange(handler: Handler<SystemEvents['dashboard_mode_change']>) {
    this.emitter.on('dashboard_mode_change', handler);
    return () => this.emitter.off('dashboard_mode_change', handler);
  }

  /**
   * 🌐 Listen for dashboard always-on mode changes
   * @param handler - Function to handle dashboard always-on mode changes
   * @returns Cleanup function to remove the handler
   */
  onDashboardAlwaysOnChange(handler: Handler<SystemEvents['dashboard_always_on_change']>) {
    this.emitter.on('dashboard_always_on_change', handler);
    return () => this.emitter.off('dashboard_always_on_change', handler);
  }

  /**
   * 🚫 Listen for permission errors when subscriptions are rejected
   * @param handler - Function to handle permission errors
   * @returns Cleanup function to remove the handler
   */
  onPermissionError(handler: Handler<SystemEvents['permission_error']>) {
    this.emitter.on('permission_error', handler);
    return () => this.emitter.off('permission_error', handler);
  }

  /**
   * 🚫 Listen for individual permission denied events for specific streams
   * @param handler - Function to handle permission denied events
   * @returns Cleanup function to remove the handler
   */
  onPermissionDenied(handler: Handler<SystemEvents['permission_denied']>) {
    this.emitter.on('permission_denied', handler);
    return () => this.emitter.off('permission_denied', handler);
  }

  /**
   * 🔄 Listen for changes to a specific setting
   * @param key - Setting key to monitor
   * @param handler - Function to handle setting value changes
   * @returns Cleanup function to remove the handler
   */
  onSettingChange<T>(key: string, handler: (value: T, previousValue: T | undefined) => void): () => void {
    let previousValue: T | undefined = undefined;

    const settingsHandler = (settings: AppSettings) => {
      try {
        const setting = settings.find(s => s.key === key);
        if (setting) {
          // Only call handler if value has changed
          if (setting.value !== previousValue) {
            const newValue = setting.value as T;
            handler(newValue, previousValue);
            previousValue = newValue;
          }
        }
      } catch (error: unknown) {
        console.error(`Error in onSettingChange handler for key "${key}":`, error);
      }
    };

    this.emitter.on('settings_update', settingsHandler);
    this.emitter.on('connected', settingsHandler); // Also check when first connected

    return () => {
      this.emitter.off('settings_update', settingsHandler);
      this.emitter.off('connected', settingsHandler);
    };
  }

  /**
   * 🔄 Generic event handler
   *
   * Use this for stream types without specific handler methods
   */
  on<T extends ExtendedStreamType>(type: T, handler: Handler<EventData<T>>): () => void {
    return this.addHandler(type, handler);
  }

  /**
   * ➕ Add an event handler and subscribe if needed
   */
  private addHandler<T extends ExtendedStreamType>(
    type: T,
    handler: Handler<EventData<T>>
  ): () => void {
    const handlers = this.handlers.get(type) ?? new Set();

    if (handlers.size === 0) {
      this.handlers.set(type, handlers);
      this.subscribe(type);
    }
    handlers.add(handler as Handler<unknown>);
    return () => this.removeHandler(type, handler);
  }

  /**
   * ➖ Remove an event handler
   */
  private removeHandler<T extends ExtendedStreamType>(
    type: T,
    handler: Handler<EventData<T>>
  ): void {
    const handlers = this.handlers.get(type);
    if (!handlers) return;

    handlers.delete(handler as Handler<unknown>);
    if (handlers.size === 0) {
      this.handlers.delete(type);
      this.unsubscribe(type);
    }
  }

  /**
   * 📡 Emit an event to all registered handlers with error isolation
   */
  emit<T extends EventType>(event: T, data: EventData<T>): void {
    try {
      // Emit to EventEmitter handlers (system events)
      // console.log(`#### Emitting to ${event}`);
      this.emitter.emit(event, data);

      // Emit to stream handlers if applicable
      const handlers = this.handlers.get(event);
      // console.log(`#### Handlers: ${JSON.stringify(handlers)}`);

      if (handlers) {
        // Create array of handlers to prevent modification during iteration
        const handlersArray = Array.from(handlers);
        // console.log(`((())) HandlersArray: ${JSON.stringify(handlersArray)}`);

        // Execute each handler in isolated try/catch to prevent one handler
        // from crashing the entire TPA
        handlersArray.forEach(handler => {
          try {
            (handler as Handler<EventData<T>>)(data);
          } catch (handlerError: unknown) {
            // Log the error but don't let it propagate
            console.error(`Error in handler for event '${String(event)}':`, handlerError);

            // Emit an error event for tracking purposes
            if (event !== 'error') { // Prevent infinite recursion
              const errorMessage = handlerError instanceof Error
                ? handlerError.message
                : String(handlerError);

              this.emitter.emit('error', new Error(
                `Handler error for event '${String(event)}': ${errorMessage}`
              ));
            }
          }
        });
      }
    } catch (emitError: unknown) {
      // Catch any errors in the emission process itself
      console.error(`Fatal error emitting event '${String(event)}':`, emitError);

      // Try to emit an error event if we're not already handling an error
      if (event !== 'error') {
        try {
          const errorMessage = emitError instanceof Error
            ? emitError.message
            : String(emitError);

          this.emitter.emit('error', new Error(
            `Event emission error for '${String(event)}': ${errorMessage}`
          ));
        } catch (nestedError) {
          // If even this fails, just log it - nothing more we can do
          console.error('Failed to emit error event:', nestedError);
        }
      }
    }
  }

  /**
   * 📨 Listen for custom messages with a specific action
   * @param action - The action identifier to filter by
   * @param handler - Function to handle the message
   * @returns Cleanup function to remove the handler
   */
  onCustomMessage(action: string, handler: (payload: any) => void): () => void {
    const messageHandler = (message: CustomMessage) => {
      if (message.action === action) {
        handler(message.payload);
      }
    };

    this.emitter.on('custom_message', messageHandler);
    return () => this.emitter.off('custom_message', messageHandler);
  }

  onVpsCoordinates(handler: Handler<VpsCoordinates>) {
    return this.addHandler(StreamType.VPS_COORDINATES, handler);
  }

  /**
   * 📸 Listen for photo responses
   * @param handler - Function to handle photo response data
   * @returns Cleanup function to remove the handler
   */
  onPhotoTaken(handler: Handler<PhotoTaken>) {
    return this.addHandler(StreamType.PHOTO_TAKEN, handler);
  }
}