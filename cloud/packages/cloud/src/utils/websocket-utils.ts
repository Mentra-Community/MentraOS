/**
 * WebSocket Event Tracking Utilities
 *
 * Helpers for tracking WebSocket event listeners with ResourceTracker
 * to ensure proper cleanup and prevent memory leaks.
 */

import WebSocket from "ws";
import { ResourceTracker } from "./resource-tracker";

/**
 * WebSocket event handlers that can be tracked
 */
export interface WebSocketHandlers {
  message?: (data: WebSocket.RawData, isBinary: boolean) => void;
  close?: (code: number, reason: Buffer) => void;
  error?: (err: Error) => void;
  open?: () => void;
  pong?: () => void;
  ping?: () => void;
}

/**
 * Track WebSocket event handlers for automatic cleanup
 *
 * Registers event handlers on the WebSocket and tracks them with the
 * ResourceTracker so they are automatically removed when dispose() is called.
 *
 * @param resources - ResourceTracker to use for cleanup tracking
 * @param ws - WebSocket to attach handlers to
 * @param handlers - Object containing event handler functions
 *
 * @example
 * ```typescript
 * const resources = new ResourceTracker();
 * const ws = new WebSocket(url);
 *
 * trackWebSocketEvents(resources, ws, {
 *   message: (data) => handleMessage(data),
 *   close: (code, reason) => handleClose(code, reason),
 *   error: (err) => handleError(err),
 * });
 *
 * // Later, when done:
 * resources.dispose(); // All handlers are removed
 * ```
 */
export function trackWebSocketEvents(
  resources: ResourceTracker,
  ws: WebSocket,
  handlers: WebSocketHandlers,
): void {
  if (handlers.message) {
    const handler = handlers.message;
    ws.on("message", handler);
    resources.track(() => ws.off("message", handler));
  }

  if (handlers.close) {
    const handler = handlers.close;
    ws.on("close", handler);
    resources.track(() => ws.off("close", handler));
  }

  if (handlers.error) {
    const handler = handlers.error;
    ws.on("error", handler);
    resources.track(() => ws.off("error", handler));
  }

  if (handlers.open) {
    const handler = handlers.open;
    ws.on("open", handler);
    resources.track(() => ws.off("open", handler));
  }

  if (handlers.pong) {
    const handler = handlers.pong;
    ws.on("pong", handler);
    resources.track(() => ws.off("pong", handler));
  }

  if (handlers.ping) {
    const handler = handlers.ping;
    ws.on("ping", handler);
    resources.track(() => ws.off("ping", handler));
  }
}

/**
 * Create a disposed-guarded handler wrapper
 *
 * Wraps a handler function to check a disposed flag before executing.
 * Useful for preventing stale callbacks from operating on disposed objects.
 *
 * @param isDisposed - Function that returns true if the object is disposed
 * @param handler - The original handler function
 * @returns A wrapped handler that no-ops if disposed
 *
 * @example
 * ```typescript
 * class MyClass {
 *   private disposed = false;
 *
 *   setup() {
 *     const handler = guardedHandler(
 *       () => this.disposed,
 *       (data) => this.handleData(data)
 *     );
 *     ws.on("message", handler);
 *   }
 * }
 * ```
 */
export function guardedHandler<T extends (...args: any[]) => any>(
  isDisposed: () => boolean,
  handler: T,
): T {
  return ((...args: Parameters<T>) => {
    if (isDisposed()) return;
    return handler(...args);
  }) as T;
}

/**
 * Remove all event listeners from a WebSocket
 *
 * Utility to forcefully remove all listeners. Use with caution -
 * prefer tracking individual handlers with trackWebSocketEvents.
 *
 * @param ws - WebSocket to remove listeners from
 */
export function removeAllWebSocketListeners(ws: WebSocket): void {
  ws.removeAllListeners("message");
  ws.removeAllListeners("close");
  ws.removeAllListeners("error");
  ws.removeAllListeners("open");
  ws.removeAllListeners("pong");
  ws.removeAllListeners("ping");
}
