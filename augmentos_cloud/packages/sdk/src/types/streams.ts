// src/streams.ts

/**
 * Types of streams that TPAs can subscribe to
 * 
 * These are events and data that TPAs can receive from the cloud.
 * Not all message types can be subscribed to as streams.
 */
export enum StreamType {
  // Hardware streams
  BUTTON_PRESS = 'button_press',
  HEAD_POSITION = 'head_position',
  GLASSES_BATTERY_UPDATE = 'glasses_battery_update',
  PHONE_BATTERY_UPDATE = 'phone_battery_update',
  GLASSES_CONNECTION_STATE = 'glasses_connection_state',
  LOCATION_UPDATE = 'location_update',
  
  // Audio streams
  TRANSCRIPTION = 'transcription',
  TRANSLATION = 'translation',
  VAD = 'VAD',
  AUDIO_CHUNK = 'audio_chunk',
  
  // Phone streams
  PHONE_NOTIFICATION = 'phone_notification',
  NOTIFICATION_DISMISSED = 'notification_dismissed',
  CALENDAR_EVENT = 'calendar_event',
  
  // System streams
  START_APP = 'start_app',
  STOP_APP = 'stop_app',
  OPEN_DASHBOARD = 'open_dashboard',
  CORE_STATUS_UPDATE = 'core_status_update',
  
  // Video streams
  VIDEO = 'video',
  PHOTO_REQUEST = 'photo_request',
  VIDEO_STREAM_REQUEST = 'video_stream_request',
  
  // Special subscription types
  ALL = 'all',
  WILDCARD = '*',
  
  // New stream type
  AUGMENTOS_SETTINGS_UPDATE_REQUEST = 'settings_update_request',
  CUSTOM_MESSAGE = 'custom_message'
}

/**
 * Extended StreamType to support language-specific streams
 * This allows us to treat language-specific strings as StreamType values
 */
export type ExtendedStreamType = StreamType | string;

/**
 * Categories of stream data
 */
export enum StreamCategory {
  /** Data from hardware sensors */
  HARDWARE = 'hardware',
  
  /** Audio processing results */
  AUDIO = 'audio',
  
  /** Phone-related events */
  PHONE = 'phone',
  
  /** System-level events */
  SYSTEM = 'system'
}

/**
 * Map of stream categories for each stream type
 */
export const STREAM_CATEGORIES: Record<StreamType, StreamCategory> = {
  [StreamType.BUTTON_PRESS]: StreamCategory.HARDWARE,
  [StreamType.HEAD_POSITION]: StreamCategory.HARDWARE,
  [StreamType.GLASSES_BATTERY_UPDATE]: StreamCategory.HARDWARE,
  [StreamType.PHONE_BATTERY_UPDATE]: StreamCategory.HARDWARE,
  [StreamType.GLASSES_CONNECTION_STATE]: StreamCategory.HARDWARE,
  [StreamType.LOCATION_UPDATE]: StreamCategory.HARDWARE,
  
  [StreamType.TRANSCRIPTION]: StreamCategory.AUDIO,
  [StreamType.TRANSLATION]: StreamCategory.AUDIO,
  [StreamType.VAD]: StreamCategory.AUDIO,
  [StreamType.AUDIO_CHUNK]: StreamCategory.AUDIO,
  
  [StreamType.PHONE_NOTIFICATION]: StreamCategory.PHONE,
  [StreamType.NOTIFICATION_DISMISSED]: StreamCategory.PHONE,
  [StreamType.CALENDAR_EVENT]: StreamCategory.PHONE,
  [StreamType.START_APP]: StreamCategory.SYSTEM,
  [StreamType.STOP_APP]: StreamCategory.SYSTEM,
  [StreamType.OPEN_DASHBOARD]: StreamCategory.SYSTEM,
  [StreamType.CORE_STATUS_UPDATE]: StreamCategory.SYSTEM,
  
  [StreamType.VIDEO]: StreamCategory.HARDWARE,
  [StreamType.PHOTO_REQUEST]: StreamCategory.HARDWARE,
  [StreamType.VIDEO_STREAM_REQUEST]: StreamCategory.HARDWARE,
  
  [StreamType.ALL]: StreamCategory.SYSTEM,
  [StreamType.WILDCARD]: StreamCategory.SYSTEM,
  
  [StreamType.AUGMENTOS_SETTINGS_UPDATE_REQUEST]: StreamCategory.SYSTEM,
  [StreamType.CUSTOM_MESSAGE]: StreamCategory.SYSTEM
};

/**
 * Branded type for TypeScript to recognize language-specific stream types
 * This helps maintain type safety when using language-specific streams
 */
export type LanguageStreamType<T extends string> = T & { __languageStreamBrand: never };

/**
 * Create a language-branded stream type
 * This is a type helper to ensure type safety for language-specific streams
 */
function createLanguageStream<T extends string>(type: T): LanguageStreamType<T> {
  return type as LanguageStreamType<T>;
}

/**
 * Structure of a parsed language stream subscription
 */
export interface LanguageStreamInfo {
  type: StreamType;                // Base stream type (e.g., TRANSCRIPTION)
  baseType: string;                // String representation of base type (e.g., "transcription")
  transcribeLanguage: string;      // Source language code (e.g., "en-US")
  translateLanguage?: string;      // Target language code for translations (e.g., "es-ES")
  original: ExtendedStreamType;    // Original subscription string
}

/**
 * Check if a string is a valid language code
 * Simple validation for language code format: xx-XX (e.g., en-US)
 */
export function isValidLanguageCode(code: string): boolean {
  return /^[a-z]{2}-[A-Z]{2}$/.test(code);
}

/**
 * Parse a subscription string to extract language information
 * 
 * @param subscription Subscription string (e.g., "transcription:en-US" or "translation:es-ES-to-en-US")
 * @returns Parsed language stream info or null if not a language-specific subscription
 */
export function parseLanguageStream(subscription: ExtendedStreamType): LanguageStreamInfo | null {
  if (typeof subscription !== 'string') {
    return null;
  }

  // console.log(`🎤 Parsing language stream: ${subscription}`);
  
  // Handle transcription format (transcription:en-US)
  if (subscription.startsWith(`${StreamType.TRANSCRIPTION}:`)) {
    const [baseType, languageCode] = subscription.split(':');

      // console.log(`🎤 Parsing transcription stream: ${subscription}`);
      // console.log(`🎤 Language code: ${languageCode}`);
      
    if (languageCode && isValidLanguageCode(languageCode)) {
      return {
        type: StreamType.TRANSCRIPTION,
        baseType,
        transcribeLanguage: languageCode,
        original: subscription
      };
    }
  }
  
  // Handle translation format (translation:es-ES-to-en-US)
  if (subscription.startsWith(`${StreamType.TRANSLATION}:`)) {
    const [baseType, languagePair] = subscription.split(':');
    const [sourceLanguage, targetLanguage] = languagePair?.split('-to-') ?? [];

    // console.log(`🎤 Parsing translation stream: ${subscription}`);
    // console.log(`🎤 Source language: ${sourceLanguage}`);
    // console.log(`🎤 Target language: ${targetLanguage}`);
    
    if (sourceLanguage && targetLanguage && 
        isValidLanguageCode(sourceLanguage) && 
        isValidLanguageCode(targetLanguage)) {
      return {
        type: StreamType.TRANSLATION,
        baseType,
        transcribeLanguage: sourceLanguage,
        translateLanguage: targetLanguage,
        original: subscription
      };
    }
  }
  
  return null;
}

/**
 * Create a transcription stream identifier for a specific language
 * Returns a type-safe stream type that can be used like a StreamType
 * 
 * @param language Language code (e.g., "en-US")
 * @returns Typed stream identifier
 */
export function createTranscriptionStream(language: string): ExtendedStreamType {
  if (!isValidLanguageCode(language)) {
    throw new Error(`Invalid language code: ${language}`);
  }
  return createLanguageStream(`${StreamType.TRANSCRIPTION}:${language}`);
}

/**
 * Create a translation stream identifier for a language pair
 * Returns a type-safe stream type that can be used like a StreamType
 * 
 * @param sourceLanguage Source language code (e.g., "es-ES")
 * @param targetLanguage Target language code (e.g., "en-US")
 * @returns Typed stream identifier
 */
export function createTranslationStream(sourceLanguage: string, targetLanguage: string): ExtendedStreamType {
  if (!isValidLanguageCode(sourceLanguage) || !isValidLanguageCode(targetLanguage)) {
    throw new Error(`Invalid language code(s): ${sourceLanguage}, ${targetLanguage}`);
  }
  return createLanguageStream(`${StreamType.TRANSLATION}:${sourceLanguage}-to-${targetLanguage}`);
}

/**
 * Check if a subscription is a valid stream type
 * This handles both enum-based StreamType values and language-specific stream formats
 * 
 * @param subscription Subscription to validate
 * @returns True if valid, false otherwise
 */
export function isValidStreamType(subscription: ExtendedStreamType): boolean {
  // Check if it's a standard StreamType
  if (Object.values(StreamType).includes(subscription as StreamType)) {
    return true;
  }
  
  // Check if it's a valid language-specific stream
  const languageStream = parseLanguageStream(subscription);
  return languageStream !== null;
}

/**
 * Helper function to check if a stream type is of a particular category
 * Works with both standard and language-specific stream types
 */
export function isStreamCategory(streamType: ExtendedStreamType, category: StreamCategory): boolean {
  const baseType = getBaseStreamType(streamType);
  return baseType ? STREAM_CATEGORIES[baseType] === category : false;
}

/**
 * Helper function to get all stream types in a category
 */
export function getStreamTypesByCategory(category: StreamCategory): StreamType[] {
  return Object.entries(STREAM_CATEGORIES)
    .filter(([_, cat]) => cat === category)
    .map(([type]) => type as StreamType);
}

/**
 * Get the base StreamType for a subscription 
 * Works with both standard StreamType values and language-specific formats
 * 
 * @param subscription Subscription string or StreamType
 * @returns The base StreamType enum value
 */
export function getBaseStreamType(subscription: ExtendedStreamType): StreamType | null {
  // Check if it's already a standard StreamType
  if (Object.values(StreamType).includes(subscription as StreamType)) {
    return subscription as StreamType;
  }
  
  // Check if it's a language-specific stream
  const languageStream = parseLanguageStream(subscription);
  return languageStream?.type ?? null;
}

/**
 * Check if a stream is a language-specific stream
 */
export function isLanguageStream(subscription: ExtendedStreamType): boolean {
  return parseLanguageStream(subscription) !== null;
}

/**
 * Get language information from a stream type
 * Returns null for regular stream types
 */
export function getLanguageInfo(subscription: ExtendedStreamType): LanguageStreamInfo | null {
  return parseLanguageStream(subscription);
}
