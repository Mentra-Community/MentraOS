// src/messages/base.ts

import { AppToCloudMessageType } from "../message-types";
import { AppToCloudMessage } from "./app-to-cloud";
import { CloudToAppMessage,  } from "./cloud-to-app";

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
