/**
 * @fileoverview WebSocket types for Bun native WebSocket compatibility.
 *
 * This module provides type definitions and utilities for working with
 * Bun's native ServerWebSocket API while maintaining compatibility with
 * existing code that was written for the `ws` package.
 */

import type { ServerWebSocket } from "bun";

/**
 * Data attached to glasses WebSocket connections
 */
export interface GlassesWebSocketData {
  type: "glasses";
  userId: string;
  livekitRequested: boolean;
  udpEncryptionRequested: boolean;
}

/**
 * Data attached to app WebSocket connections
 */
export interface AppWebSocketData {
  type: "app";
  userId: string;
  sessionId: string;
  packageName?: string;
  appJwtPayload?: {
    packageName: string;
    apiKey: string;
  };
}

/**
 * Union type for all WebSocket connection data
 */
export type WebSocketData = GlassesWebSocketData | AppWebSocketData;

/**
 * Bun ServerWebSocket with glasses data
 */
export type GlassesServerWebSocket = ServerWebSocket<GlassesWebSocketData>;

/**
 * Bun ServerWebSocket with app data
 */
export type AppServerWebSocket = ServerWebSocket<AppWebSocketData>;

/**
 * Generic Bun ServerWebSocket with our data types
 */
export type CloudServerWebSocket = ServerWebSocket<WebSocketData>;

/**
 * WebSocket ready states (same as standard WebSocket)
 */
export const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * Common WebSocket interface that works with both `ws` and Bun's ServerWebSocket.
 *
 * This interface defines the subset of WebSocket functionality used throughout
 * the codebase, allowing code to work with either implementation.
 *
 * Key differences between ws and Bun's ServerWebSocket:
 * - ws uses event emitters: ws.on("message", ...), ws.on("pong", ...)
 * - Bun uses handler callbacks in websocket config: { message(ws, msg), pong(ws, data) }
 * - Both support: send(), close(), ping(), readyState
 */
export interface IWebSocket {
  /** Current connection state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) */
  readonly readyState: number;

  /** Send data through the WebSocket */
  send(data: string | Buffer | ArrayBuffer | Uint8Array): number | void;

  /** Close the connection */
  close(code?: number, reason?: string): void;

  /**
   * Send a ping frame.
   * Optional because not all WebSocket implementations expose this method.
   */
  ping?(data?: string | Buffer | Uint8Array): void;

  /**
   * Subscribe to events (ws package style).
   * Bun's ServerWebSocket doesn't have this - events are handled in websocketHandlers.
   * This is optional to support both APIs.
   */
  on?(event: string, listener: (...args: any[]) => void): void;

  /**
   * Unsubscribe from events (ws package style).
   * Optional for the same reason as `on`.
   */
  off?(event: string, listener: (...args: any[]) => void): void;
}

/**
 * Type alias for backwards compatibility with code expecting WebSocket from ws package.
 * This allows gradual migration from `import WebSocket from "ws"` to `import { IWebSocket }`.
 */
export type WebSocket = IWebSocket;

/**
 * Check if websocket supports event emitter style (ws package)
 */
export function hasEventEmitter(ws: IWebSocket): ws is IWebSocket & {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
} {
  return typeof (ws as any).on === "function" && typeof (ws as any).off === "function";
}

/**
 * Type guard to check if a WebSocket is open
 */
export function isWebSocketOpen(ws: IWebSocket | null | undefined): ws is IWebSocket {
  return ws !== null && ws !== undefined && ws.readyState === WebSocketReadyState.OPEN;
}

/**
 * Type guard for glasses WebSocket data
 */
export function isGlassesWebSocket(ws: CloudServerWebSocket): ws is GlassesServerWebSocket {
  return ws.data.type === "glasses";
}

/**
 * Type guard for app WebSocket data
 */
export function isAppWebSocket(ws: CloudServerWebSocket): ws is AppServerWebSocket {
  return ws.data.type === "app";
}
