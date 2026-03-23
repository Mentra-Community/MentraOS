/**
 * Message types sent from WebView to Native
 */
export type OutgoingMessageType =
  | "page_ready"
  | "core_fn"
  | "sub_transcription"
  | "sub_audio"
  | "sub_movement"
  | "unsub_transcription"
  | "unsub_audio"
  | "unsub_movement"

/**
 * Message types received from Native
 */
export type IncomingMessageType = "transcription" | "audio" | "movement"

/**
 * Base message structure
 */
export interface BaseMessage {
  type: string
  timestamp?: number
}

/**
 * Message sent from WebView to Native
 */
export interface OutgoingMessage extends BaseMessage {
  type: OutgoingMessageType
  payload?: any
}

/**
 * Message received from Native
 */
export interface IncomingMessage extends BaseMessage {
  type: IncomingMessageType
  payload: any
}

/**
 * Transcription message payload
 */
export interface TranscriptionPayload {
  message: string
  isFinal?: boolean
  timestamp?: number
}

/**
 * Audio message payload
 */
export interface AudioPayload {
  data: ArrayBuffer | string
  timestamp?: number
}

/**
 * Movement message payload
 */
export interface MovementPayload {
  x: number
  y: number
  z: number
  timestamp?: number
}

/**
 * Core function names
 */
export type CoreFunctionName = "displayText" | "setMicState"

/**
 * Display text arguments
 */
export interface DisplayTextArgs {
  text: string
}

/**
 * Microphone state
 */
export type MicState = "on" | "off" | "muted"

/**
 * Set mic state arguments
 */
export interface SetMicStateArgs {
  state: MicState
}

/**
 * Transcription subscription options
 */
export interface TranscriptionOptions {
  type: "online" | "local"
  fallback?: boolean
}

/**
 * Audio subscription options
 */
export interface AudioOptions {
  sampleRate?: number
  channels?: number
}

/**
 * Movement subscription options
 */
export interface MovementOptions {
  frequency?: number
}

/**
 * Subscription handler function
 */
export type SubscriptionHandler<T = any> = (data: T) => void

/**
 * Subscription type
 */
export type SubscriptionType = "transcription" | "audio" | "movement"
