// src/streams.ts

/**
 * Types of streams that Apps can subscribe to
 *
 * These are events and data that Apps can receive from the cloud.
 * Not all message types can be subscribed to as streams.
 */
export enum StreamType {
  // Hardware streams
  BUTTON_PRESS = "button_press",
  HEAD_POSITION = "head_position",
  TOUCH_EVENT = "touch_event",
  GLASSES_BATTERY_UPDATE = "glasses_battery_update",
  PHONE_BATTERY_UPDATE = "phone_battery_update",
  GLASSES_CONNECTION_STATE = "glasses_connection_state",
  LOCATION_UPDATE = "location_update",
  LOCATION_STREAM = "location_stream",
  VPS_COORDINATES = "vps_coordinates",

  // Audio streams
  TRANSCRIPTION = "transcription",
  TRANSLATION = "translation",
  VAD = "VAD",
  AUDIO_CHUNK = "audio_chunk",

  // Phone streams
  PHONE_NOTIFICATION = "phone_notification",
  PHONE_NOTIFICATION_DISMISSED = "phone_notification_dismissed",
  CALENDAR_EVENT = "calendar_event",

  // System streams
  START_APP = "start_app",
  STOP_APP = "stop_app",
  OPEN_DASHBOARD = "open_dashboard",
  CORE_STATUS_UPDATE = "core_status_update",

  // Video streams
  VIDEO = "video",
  PHOTO_REQUEST = "photo_request",
  PHOTO_RESPONSE = "photo_response",
  RTMP_STREAM_STATUS = "rtmp_stream_status",
  MANAGED_STREAM_STATUS = "managed_stream_status",

  // Special subscription types
  ALL = "all",
  WILDCARD = "*",

  // New stream type
  MENTRAOS_SETTINGS_UPDATE_REQUEST = "settings_update_request",
  /**
   * @deprecated Use the settings system (mentraosSettings) instead.
   * This stream type was used for datetime updates but is no longer needed.
   * Will be removed in a future version.
   */
  CUSTOM_MESSAGE = "custom_message",
  PHOTO_TAKEN = "photo_taken",
}

/**
 * Extended StreamType to support language-specific streams
 * This allows us to treat language-specific strings as StreamType values
 */
export type ExtendedStreamType = StreamType | string

/**
 * Categories of stream data
 */
export enum StreamCategory {
  /** Data from hardware sensors */
  HARDWARE = "hardware",

  /** Audio processing results */
  AUDIO = "audio",

  /** Phone-related events */
  PHONE = "phone",

  /** System-level events */
  SYSTEM = "system",
}

/**
 * Map of stream categories for each stream type
 */
export const STREAM_CATEGORIES: Record<StreamType, StreamCategory> = {
  [StreamType.BUTTON_PRESS]: StreamCategory.HARDWARE,
  [StreamType.HEAD_POSITION]: StreamCategory.HARDWARE,
  [StreamType.TOUCH_EVENT]: StreamCategory.HARDWARE,
  [StreamType.GLASSES_BATTERY_UPDATE]: StreamCategory.HARDWARE,
  [StreamType.PHONE_BATTERY_UPDATE]: StreamCategory.HARDWARE,
  [StreamType.GLASSES_CONNECTION_STATE]: StreamCategory.HARDWARE,
  [StreamType.LOCATION_UPDATE]: StreamCategory.HARDWARE,
  [StreamType.LOCATION_STREAM]: StreamCategory.HARDWARE,
  [StreamType.VPS_COORDINATES]: StreamCategory.HARDWARE,

  [StreamType.TRANSCRIPTION]: StreamCategory.AUDIO,
  [StreamType.TRANSLATION]: StreamCategory.AUDIO,
  [StreamType.VAD]: StreamCategory.AUDIO,
  [StreamType.AUDIO_CHUNK]: StreamCategory.AUDIO,

  [StreamType.PHONE_NOTIFICATION]: StreamCategory.PHONE,
  [StreamType.PHONE_NOTIFICATION_DISMISSED]: StreamCategory.PHONE,
  [StreamType.CALENDAR_EVENT]: StreamCategory.PHONE,
  [StreamType.START_APP]: StreamCategory.SYSTEM,
  [StreamType.STOP_APP]: StreamCategory.SYSTEM,
  [StreamType.OPEN_DASHBOARD]: StreamCategory.SYSTEM,
  [StreamType.CORE_STATUS_UPDATE]: StreamCategory.SYSTEM,

  [StreamType.VIDEO]: StreamCategory.HARDWARE,
  [StreamType.PHOTO_REQUEST]: StreamCategory.HARDWARE,
  [StreamType.PHOTO_RESPONSE]: StreamCategory.HARDWARE,
  [StreamType.RTMP_STREAM_STATUS]: StreamCategory.HARDWARE,
  [StreamType.MANAGED_STREAM_STATUS]: StreamCategory.HARDWARE,
  [StreamType.ALL]: StreamCategory.SYSTEM,
  [StreamType.WILDCARD]: StreamCategory.SYSTEM,

  [StreamType.MENTRAOS_SETTINGS_UPDATE_REQUEST]: StreamCategory.SYSTEM,
  [StreamType.CUSTOM_MESSAGE]: StreamCategory.SYSTEM,
  [StreamType.PHOTO_TAKEN]: StreamCategory.HARDWARE,
}

/**
 * Branded type for TypeScript to recognize language-specific stream types
 * This helps maintain type safety when using language-specific streams
 */
export type LanguageStreamType<T extends string> = T & {
  __languageStreamBrand: never
}

/**
 * Create a language-branded stream type
 * This is a type helper to ensure type safety for language-specific streams
 */
function createLanguageStream<T extends string>(type: T): LanguageStreamType<T> {
  return type as LanguageStreamType<T>
}

/**
 * Structure of a parsed language stream subscription
 */
export interface LanguageStreamInfo {
  type: StreamType // Base stream type (e.g., TRANSCRIPTION)
  baseType: string // String representation of base type (e.g., "transcription")
  transcribeLanguage: string // Source language code (e.g., "en-US")
  translateLanguage?: string // Target language code for translations (e.g., "es-ES")
  options?: Record<string, string | boolean> // Query parameters/options
  original: ExtendedStreamType // Original subscription string
}

/**
 * Check if a string is a valid language code
 * Simple validation for language code format: xx-XX (e.g., en-US)
 */
export function isValidLanguageCode(code: string): boolean {
  return /^[a-z]{2,3}-[A-Z]{2}$/.test(code)
}

/**
 * Parse a subscription string to extract language information
 *
 * @param subscription Subscription string (e.g., "transcription:en-US" or "translation:es-ES-to-en-US" or "transcription:en-US?no-language-identification=true")
 * @returns Parsed language stream info or null if not a language-specific subscription
 */
export function parseLanguageStream(subscription: ExtendedStreamType): LanguageStreamInfo | null {
  // console.log(`🎤 Parsing language stream: ${subscription}`);

  if (typeof subscription !== "string") {
    return null
  }

  // Handle transcription format (transcription:en-US or transcription:en-US?options)
  if (subscription.startsWith(`${StreamType.TRANSCRIPTION}:`)) {
    const [baseType, rest] = subscription.split(":")
    const [languageCode, queryString] = rest?.split("?") ?? []

    if (languageCode && isValidLanguageCode(languageCode)) {
      const options: Record<string, string | boolean> = {}

      // Parse query parameters if present
      if (queryString) {
        const params = new URLSearchParams(queryString)
        for (const [key, value] of params.entries()) {
          // Convert string values to boolean when appropriate
          if (value === "true") {
            options[key] = true
          } else if (value === "false") {
            options[key] = false
          } else {
            options[key] = value
          }
        }
      }

      return {
        type: StreamType.TRANSCRIPTION,
        baseType,
        transcribeLanguage: languageCode,
        options: Object.keys(options).length > 0 ? options : undefined,
        original: subscription,
      }
    }
  }

  // Handle translation format (translation:es-ES-to-en-US, translation:all-to-en-US, or with ?options)
  if (subscription.startsWith(`${StreamType.TRANSLATION}:`)) {
    const [baseType, rest] = subscription.split(":")
    const [languagePair, queryString] = rest?.split("?") ?? []
    const [sourceLanguage, targetLanguage] = languagePair?.split("-to-") ?? []

    // Check for "all-to-LANG" format (one-way translation from any language)
    const isAllToFormat = sourceLanguage === "all" && targetLanguage && isValidLanguageCode(targetLanguage)

    // Check for "LANG-to-LANG" format (two-way translation between specific languages)
    const isSpecificPairFormat =
      sourceLanguage && targetLanguage && isValidLanguageCode(sourceLanguage) && isValidLanguageCode(targetLanguage)

    if (isAllToFormat || isSpecificPairFormat) {
      const options: Record<string, string | boolean> = {}

      // Parse query parameters if present
      if (queryString) {
        const params = new URLSearchParams(queryString)
        for (const [key, value] of params.entries()) {
          // Convert string values to boolean when appropriate
          if (value === "true") {
            options[key] = true
          } else if (value === "false") {
            options[key] = false
          } else {
            options[key] = value
          }
        }
      }

      return {
        type: StreamType.TRANSLATION,
        baseType,
        transcribeLanguage: sourceLanguage, // "all" for all-to-LANG, or specific language code
        translateLanguage: targetLanguage,
        options: Object.keys(options).length > 0 ? options : undefined,
        original: subscription,
      }
    }
  }

  return null
}

/**
 * Create a transcription stream identifier for a specific language
 * Returns a type-safe stream type that can be used like a StreamType
 *
 * @param language Language code (e.g., "en-US") or "auto" for automatic detection
 * @param options Optional configuration options
 * @returns Typed stream identifier
 */
export function createTranscriptionStream(
  language: string,
  options?: {
    disableLanguageIdentification?: boolean
    hints?: string[]
  },
): ExtendedStreamType {
  console.log(`🎤 Creating transcription stream for language: ${language}`)
  console.log(`🎤 Options: ${JSON.stringify(options)}`)

  // Defensively remove any query string from the language parameter
  const languageCode = language.split("?")[0]

  if (languageCode !== "auto" && !isValidLanguageCode(languageCode)) {
    throw new Error(`Invalid language code: ${languageCode}`)
  }

  const base = `${StreamType.TRANSCRIPTION}:${languageCode}`
  const params = new URLSearchParams()

  if (options?.disableLanguageIdentification) {
    params.set("no-language-identification", "true")
  }

  if (options?.hints && options.hints.length > 0) {
    params.set("hints", options.hints.join(","))
  }

  const queryString = params.toString()
  return queryString ? (`${base}?${queryString}` as ExtendedStreamType) : (base as ExtendedStreamType)
}

/**
 * Create a translation stream identifier for a language pair
 * Returns a type-safe stream type that can be used like a StreamType
 *
 * @param sourceLanguage Source language code (e.g., "es-ES") or "all" for one-way translation
 * @param targetLanguage Target language code (e.g., "en-US")
 * @param options Optional configuration options
 * @returns Typed stream identifier
 */
export function createTranslationStream(
  sourceLanguage: string,
  targetLanguage: string,
  options?: {disableLanguageIdentification?: boolean},
): ExtendedStreamType {
  // Defensively remove any query string from the language parameters
  const cleanSourceLanguage = sourceLanguage.split("?")[0]
  const cleanTargetLanguage = targetLanguage.split("?")[0]

  // Support "all" as source for one-way translation (all languages → target)
  const isAllToFormat = cleanSourceLanguage === "all"

  if ((!isAllToFormat && !isValidLanguageCode(cleanSourceLanguage)) || !isValidLanguageCode(cleanTargetLanguage)) {
    throw new Error(`Invalid language code(s): ${cleanSourceLanguage}, ${cleanTargetLanguage}`)
  }
  const base = `${StreamType.TRANSLATION}:${cleanSourceLanguage}-to-${cleanTargetLanguage}`
  if (options?.disableLanguageIdentification) {
    return `${base}?no-language-identification=true` as ExtendedStreamType
  }
  return createLanguageStream(base)
}

/**
 * Parse a touch event subscription to extract gesture information
 * @param subscription Subscription string (e.g., "touch_event:forward_swipe")
 * @returns Gesture name or null if not a gesture-specific subscription
 */
export function parseTouchEventStream(subscription: ExtendedStreamType): string | null {
  if (typeof subscription !== "string") {
    return null
  }

  if (subscription.startsWith(`${StreamType.TOUCH_EVENT}:`)) {
    const [, gestureName] = subscription.split(":")
    const validGestures = [
      "single_tap",
      "double_tap",
      "triple_tap",
      "long_press",
      "forward_swipe",
      "backward_swipe",
      "up_swipe",
      "down_swipe",
    ]

    if (gestureName && validGestures.includes(gestureName)) {
      return gestureName
    }
  }

  return null
}

/**
 * Create a touch event subscription for a specific gesture
 * @param gesture Gesture name (e.g., "forward_swipe")
 * @returns Typed stream identifier
 */
export function createTouchEventStream(gesture: string): ExtendedStreamType {
  const validGestures = [
    "single_tap",
    "double_tap",
    "triple_tap",
    "long_press",
    "forward_swipe",
    "backward_swipe",
    "up_swipe",
    "down_swipe",
  ]

  if (!validGestures.includes(gesture)) {
    throw new Error(`Invalid gesture: ${gesture}`)
  }

  return `${StreamType.TOUCH_EVENT}:${gesture}` as ExtendedStreamType
}

/**
 * Create a universal translation stream identifier that translates from any language to target
 * This is useful when you want to support all languages translating to a single target
 * Returns a type-safe stream type that can be used like a StreamType
 *
 * Example: createUniversalTranslationStream('es-ES') creates "translation:all-to-es-ES"
 *
 * @param targetLanguage Target language code (e.g., "es-ES")
 * @param options Optional configuration options
 * @returns Typed stream identifier
 */
export function createUniversalTranslationStream(
  targetLanguage: string,
  options?: {disableLanguageIdentification?: boolean},
): ExtendedStreamType {
  const cleanTargetLanguage = targetLanguage.split("?")[0]

  if (!isValidLanguageCode(cleanTargetLanguage)) {
    throw new Error(`Invalid target language code: ${cleanTargetLanguage}`)
  }

  const base = `${StreamType.TRANSLATION}:all-to-${cleanTargetLanguage}`
  if (options?.disableLanguageIdentification) {
    return `${base}?no-language-identification=true` as ExtendedStreamType
  }
  return createLanguageStream(base)
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
    return true
  }

  // Check if it's a valid language-specific stream
  const languageStream = parseLanguageStream(subscription)
  if (languageStream !== null) {
    return true
  }

  // Check if it's a valid gesture-specific stream
  const gestureStream = parseTouchEventStream(subscription)
  if (gestureStream !== null) {
    return true
  }

  return false
}

/**
 * Helper function to check if a stream type is of a particular category
 * Works with both standard and language-specific stream types
 */
export function isStreamCategory(streamType: ExtendedStreamType, category: StreamCategory): boolean {
  const baseType = getBaseStreamType(streamType)
  return baseType ? STREAM_CATEGORIES[baseType] === category : false
}

/**
 * Helper function to get all stream types in a category
 */
export function getStreamTypesByCategory(category: StreamCategory): StreamType[] {
  return Object.entries(STREAM_CATEGORIES)
    .filter(([_, cat]) => cat === category)
    .map(([type]) => type as StreamType)
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
    return subscription as StreamType
  }

  // Check if it's a language-specific stream
  const languageStream = parseLanguageStream(subscription)
  if (languageStream) {
    return languageStream.type
  }

  // Check if it's a gesture-specific stream
  const gestureStream = parseTouchEventStream(subscription)
  if (gestureStream) {
    return StreamType.TOUCH_EVENT
  }

  return null
}

/**
 * Check if a stream is a language-specific stream
 */
export function isLanguageStream(subscription: ExtendedStreamType): boolean {
  return parseLanguageStream(subscription) !== null
}

/**
 * Get language information from a stream type
 * Returns null for regular stream types
 */
export function getLanguageInfo(subscription: ExtendedStreamType): LanguageStreamInfo | null {
  return parseLanguageStream(subscription)
}

// this is the blueprint for our new rich subscription object
// it allows a developer to specify a rate for the location stream
export interface LocationStreamRequest {
  stream: "location_stream"
  rate: "standard" | "high" | "realtime" | "tenMeters" | "hundredMeters" | "kilometer" | "threeKilometers" | "reduced"
}
