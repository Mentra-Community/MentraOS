/**
 * 🎮 Event Manager Module
 */
import EventEmitter from "events";
import type { Logger } from "pino";
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
  AudioChunk,
  CalendarEvent,
  VpsCoordinates,
  // Language stream helpers
  createTranscriptionStream,
  isValidLanguageCode,
  createTranslationStream,
  isLanguageStream,
  parseLanguageStream,
  CustomMessage,
  RtmpStreamStatus,
  PhotoTaken,
  ManagedStreamStatus,
  PhoneNotificationDismissed,
  Capabilities,
  TouchEvent,
  createTouchEventStream,
} from "../../types";
import { DashboardMode } from "../../types/dashboard";
import { PermissionErrorDetail } from "../../types/messages/cloud-to-app";
import { calendarWarnLog, microPhoneWarnLog } from "../../utils/permissions-utils";

/** 🎯 Type-safe event handler function */
type Handler<T> = (data: T) => void;

/** 🔄 System events not tied to streams */
interface SystemEvents {
  connected: AppSettings | undefined;
  disconnected:
    | string
    | {
        message: string; // Human-readable close message
        code: number; // WebSocket close code (1000 = normal)
        reason: string; // Reason provided by server
        wasClean: boolean; // Whether this was a clean closure
        permanent?: boolean; // Whether this is a permanent disconnection (no more reconnection attempts)
        sessionEnded?: boolean; // Whether this disconnection is due to user session ending
      };
  error: WebSocketError | Error;
  settings_update: AppSettings;
  capabilities_update: {
    capabilities: Capabilities | null;
    modelName: string | null;
    timestamp?: Date;
  };
  dashboard_mode_change: { mode: DashboardMode | "none" };
  dashboard_always_on_change: { enabled: boolean };
  custom_message: CustomMessage;
  permission_error: {
    message: string;
    details: PermissionErrorDetail[];
    timestamp?: Date;
  };
  permission_denied: {
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
  [StreamType.PHONE_NOTIFICATION_DISMISSED]: PhoneNotificationDismissed;
  [StreamType.AUDIO_CHUNK]: AudioChunk;
  [StreamType.VIDEO]: ArrayBuffer;
  [StreamType.RTMP_STREAM_STATUS]: RtmpStreamStatus;
  [StreamType.MANAGED_STREAM_STATUS]: ManagedStreamStatus;
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
  private logger: Logger;

  constructor(
    private subscribe: (type: ExtendedStreamType) => void,
    private unsubscribe: (type: ExtendedStreamType) => void,
    private packageName: string,
    private baseUrl: string,
    logger: Logger,
  ) {
    this.emitter = new EventEmitter();
    this.handlers = new Map();
    this.lastLanguageTranscriptioCleanupHandler = () => {};
    this.lastLanguageTranslationCleanupHandler = () => {};
    this.logger = logger;
  }

  // Convenience handlers for common event types

  onTranscription(handler: Handler<TranscriptionData>) {
    // Only make the API call if we have a base URL (server-side environment)
    microPhoneWarnLog(this.baseUrl, this.packageName, this.onTranscription.name, this.logger);

    return this.addHandler(createTranscriptionStream("en-US"), handler);
  }

  /**
   * 🎤 Listen for transcription events in a specific language
   * @param language - Language code (e.g., "en-US") or "auto" for automatic detection
   * @param handler - Function to handle transcription data
   * @param optionsOrBoolean - Optional configuration object or boolean (backward compatible)
   * @param optionsOrBoolean.disableLanguageIdentification - Disable language identification (defaults to false/enabled)
   * @param optionsOrBoolean.hints - Array of language code hints to improve detection (e.g., ["es", "fr"])
   * @returns Cleanup function to remove the handler
   * @throws Error if language code is invalid
   */
  onTranscriptionForLanguage(
    language: string,
    handler: Handler<TranscriptionData>,
    optionsOrBoolean?:
      | boolean
      | {
          disableLanguageIdentification?: boolean;
          hints?: string[];
        },
  ): () => void {
    if (language !== "auto" && !isValidLanguageCode(language)) {
      throw new Error(`Invalid language code: ${language}`);
    }
    this.lastLanguageTranscriptioCleanupHandler();

    // Handle backward compatibility: boolean or options object
    const options =
      typeof optionsOrBoolean === "boolean" ? { disableLanguageIdentification: optionsOrBoolean } : optionsOrBoolean;

    const streamType = createTranscriptionStream(language, options);
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
  ontranslationForLanguage(
    sourceLanguage: string,
    targetLanguage: string,
    handler: Handler<TranslationData>,
  ): () => void {
    microPhoneWarnLog(this.baseUrl || "", this.packageName, this.ontranslationForLanguage.name, this.logger);
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

  onTouchEvent(gestureOrHandler: string | Handler<TouchEvent>, handler?: Handler<TouchEvent>): () => void {
    // Handle both: onTouchEvent(handler) and onTouchEvent("forward_swipe", handler)
    if (typeof gestureOrHandler === "function") {
      // Subscribe to all touch events
      return this.addHandler(StreamType.TOUCH_EVENT, gestureOrHandler);
    } else {
      // Subscribe to specific gesture
      const gestureStream = createTouchEventStream(gestureOrHandler);
      return this.addHandler(gestureStream, handler!);
    }
  }

  onPhoneNotifications(handler: Handler<PhoneNotification>) {
    return this.addHandler(StreamType.PHONE_NOTIFICATION, handler);
  }

  onPhoneNotificationDismissed(handler: Handler<PhoneNotificationDismissed>) {
    return this.addHandler(StreamType.PHONE_NOTIFICATION_DISMISSED, handler);
  }

  onGlassesBattery(handler: Handler<GlassesBatteryUpdate>) {
    return this.addHandler(StreamType.GLASSES_BATTERY_UPDATE, handler);
  }

  onPhoneBattery(handler: Handler<PhoneBatteryUpdate>) {
    return this.addHandler(StreamType.PHONE_BATTERY_UPDATE, handler);
  }

  onVoiceActivity(handler: Handler<Vad>) {
    microPhoneWarnLog(this.baseUrl || "", this.packageName, this.onVoiceActivity.name, this.logger);
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

  onConnected(handler: Handler<SystemEvents["connected"]>) {
    this.emitter.on("connected", handler);
    return () => this.emitter.off("connected", handler);
  }

  onDisconnected(handler: Handler<SystemEvents["disconnected"]>) {
    this.emitter.on("disconnected", handler);
    return () => this.emitter.off("disconnected", handler);
  }

  onError(handler: Handler<SystemEvents["error"]>) {
    this.emitter.on("error", handler);
    return () => this.emitter.off("error", handler);
  }

  onSettingsUpdate(handler: Handler<SystemEvents["settings_update"]>) {
    this.emitter.on("settings_update", handler);
    return () => this.emitter.off("settings_update", handler);
  }

  /**
   * 🔧 Listen for device capabilities updates
   * @param handler - Function to handle capabilities updates
   * @returns Cleanup function to remove the handler
   */
  onCapabilitiesUpdate(handler: Handler<SystemEvents["capabilities_update"]>) {
    this.emitter.on("capabilities_update", handler);
    return () => this.emitter.off("capabilities_update", handler);
  }

  /**
   * 🌐 Listen for dashboard mode changes
   * @param handler - Function to handle dashboard mode changes
   * @returns Cleanup function to remove the handler
   */
  onDashboardModeChange(handler: Handler<SystemEvents["dashboard_mode_change"]>) {
    this.emitter.on("dashboard_mode_change", handler);
    return () => this.emitter.off("dashboard_mode_change", handler);
  }

  /**
   * 🌐 Listen for dashboard always-on mode changes
   * @param handler - Function to handle dashboard always-on mode changes
   * @returns Cleanup function to remove the handler
   */
  onDashboardAlwaysOnChange(handler: Handler<SystemEvents["dashboard_always_on_change"]>) {
    this.emitter.on("dashboard_always_on_change", handler);
    return () => this.emitter.off("dashboard_always_on_change", handler);
  }

  /**
   * 🚫 Listen for permission errors when subscriptions are rejected
   * @param handler - Function to handle permission errors
   * @returns Cleanup function to remove the handler
   */
  onPermissionError(handler: Handler<SystemEvents["permission_error"]>) {
    this.emitter.on("permission_error", handler);
    return () => this.emitter.off("permission_error", handler);
  }

  /**
   * 🚫 Listen for individual permission denied events for specific streams
   * @param handler - Function to handle permission denied events
   * @returns Cleanup function to remove the handler
   */
  onPermissionDenied(handler: Handler<SystemEvents["permission_denied"]>) {
    this.emitter.on("permission_denied", handler);
    return () => this.emitter.off("permission_denied", handler);
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
        const setting = settings.find((s) => s.key === key);
        if (setting) {
          // Only call handler if value has changed
          if (setting.value !== previousValue) {
            const newValue = setting.value as T;
            handler(newValue, previousValue);
            previousValue = newValue;
          }
        }
      } catch (error: unknown) {
        this.logger.debug({ key, error }, `Error in onSettingChange handler for key "${key}"`);
      }
    };

    this.emitter.on("settings_update", settingsHandler);
    this.emitter.on("connected", settingsHandler); // Also check when first connected

    return () => {
      this.emitter.off("settings_update", settingsHandler);
      this.emitter.off("connected", settingsHandler);
    };
  }

  /**
   * 🔄 Generic event handler
   *
   * Use this for stream types without specific handler methods
   */
  on<T extends ExtendedStreamType>(type: T, handler: Handler<EventData<T>>): () => void {
    // Check permissions for specific stream types
    if (type === StreamType.CALENDAR_EVENT) {
      calendarWarnLog(this.baseUrl, this.packageName, "on", this.logger);
    }
    return this.addHandler(type, handler);
  }

  /**
   * ➕ Add an event handler and subscribe if needed
   */
  private addHandler<T extends ExtendedStreamType>(type: T, handler: Handler<EventData<T>>): () => void {
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
  private removeHandler<T extends ExtendedStreamType>(type: T, handler: Handler<EventData<T>>): void {
    const handlers = this.handlers.get(type);
    if (!handlers) return;

    handlers.delete(handler as Handler<unknown>);
    if (handlers.size === 0) {
      this.handlers.delete(type);
      this.unsubscribe(type);
    }
  }

  /**
   * 🔍 Get all currently registered stream types
   * Returns the streams that have at least one handler registered.
   * Used to derive subscriptions from handlers (single source of truth).
   *
   * This is the fix for Bug 007: subscriptions are now derived from handlers
   * instead of being stored separately, preventing drift between the two.
   */
  getRegisteredStreams(): ExtendedStreamType[] {
    return Array.from(this.handlers.keys()) as ExtendedStreamType[];
  }

  /**
   * 🔍 Find a registered stream that matches the incoming stream type.
   *
   * For non-language streams: exact match (existing behavior).
   * For language streams: compare base type + transcribeLanguage
   * (+ translateLanguage for translations), ignoring query params like ?hints=.
   *
   * This allows the SDK to receive data from a cloud stream whose subscription
   * string doesn't include the same query params as the handler's subscription.
   * For example, incoming "transcription:en-US" matches handler "transcription:en-US?hints=ja".
   */
  findMatchingStream(incoming: ExtendedStreamType): ExtendedStreamType | null {
    // Fast path: exact match
    if (this.handlers.has(incoming)) {
      return incoming;
    }

    // For language streams, try base-language matching
    if (isLanguageStream(incoming as string)) {
      const incomingParsed = parseLanguageStream(incoming);
      if (!incomingParsed) return null;

      for (const key of this.handlers.keys()) {
        if (!isLanguageStream(key as string)) continue;

        const keyParsed = parseLanguageStream(key as ExtendedStreamType);
        if (!keyParsed) continue;

        // Compare base type
        if (keyParsed.type !== incomingParsed.type) continue;

        // Compare transcribe language
        if (keyParsed.transcribeLanguage !== incomingParsed.transcribeLanguage) continue;

        // For translations, also compare target language
        if (incomingParsed.translateLanguage || keyParsed.translateLanguage) {
          if (keyParsed.translateLanguage !== incomingParsed.translateLanguage) continue;
        }

        return key as ExtendedStreamType;
      }
    }

    return null;
  }

  /**
   * 📡 Emit an event to all registered handlers with error isolation
   */
  emit<T extends EventType>(event: T, data: EventData<T>): void {
    try {
      // Emit to EventEmitter handlers (system events)
      this.emitter.emit(event, data);

      // Emit to stream handlers if applicable
      const handlers = this.handlers.get(event);

      if (handlers) {
        // Create array of handlers to prevent modification during iteration
        const handlersArray = Array.from(handlers);

        // Execute each handler in isolated try/catch to prevent one handler
        // from crashing the entire App
        handlersArray.forEach((handler) => {
          try {
            (handler as Handler<EventData<T>>)(data);
          } catch (handlerError: unknown) {
            // Log at debug — the error event (emitted below) is the primary output path
            this.logger.debug(
              { event: String(event), error: handlerError },
              `Error in handler for event '${String(event)}'`,
            );

            // Emit an error event for tracking purposes
            if (event !== "error") {
              // Prevent infinite recursion
              const errorMessage = handlerError instanceof Error ? handlerError.message : String(handlerError);

              this.emitter.emit("error", new Error(`Handler error for event '${String(event)}': ${errorMessage}`));
            }
          }
        });
      }

      // Fallback: if this is an error event and nobody is listening, log it.
      // This prevents errors from being silently swallowed when dev has no onError handler.
      if (event === "error" && this.emitter.listenerCount("error") === 0 && (!handlers || handlers.size === 0)) {
        const error = data as unknown as Error;
        this.logger.error(error?.message ?? String(data));
      }
    } catch (emitError: unknown) {
      // Catch any errors in the emission process itself
      this.logger.debug({ event: String(event), error: emitError }, `Fatal error emitting event '${String(event)}'`);

      // Try to emit an error event if we're not already handling an error
      if (event !== "error") {
        try {
          const errorMessage = emitError instanceof Error ? emitError.message : String(emitError);

          this.emitter.emit("error", new Error(`Event emission error for '${String(event)}': ${errorMessage}`));
        } catch {
          // If even this fails, log it — nothing more we can do
          this.logger.debug("Failed to emit error event after emission failure");
        }
      }
    }
  }

  /**
   * 📨 Listen for custom messages with a specific action
   * @param action - The action identifier to filter by
   * @param handler - Function to handle the message
   * @returns Cleanup function to remove the handler
   * @deprecated Use settings.onMentraosChange() instead for system settings.
   * This method was used for datetime updates but is no longer needed.
   * Will be removed in a future version.
   */
  onCustomMessage(action: string, handler: (payload: any) => void): () => void {
    const messageHandler = (message: CustomMessage) => {
      if (message.action === action) {
        handler(message.payload);
      }
    };

    this.emitter.on("custom_message", messageHandler);
    return () => this.emitter.off("custom_message", messageHandler);
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
