// src/messages/base.ts

/**
 * Base interface for all messages in the system
 */
export interface BaseMessage {
  /** Type of the message */
  type: string;

  /** When the message was created */
  timestamp?: Date;

  /** Session identifier for routing */
  sessionId?: string;
}
