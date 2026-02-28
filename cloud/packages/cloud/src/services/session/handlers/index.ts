/**
 * @fileoverview Message Handlers Index
 *
 * Exports all message handlers for glasses and app WebSocket messages.
 * These handlers extract message routing logic from WebSocket services
 * to make it testable and keep WebSocket services focused on connection lifecycle.
 *
 * Part of Issue 009-001: Extract Message Routing
 */

export { handleGlassesMessage } from "./glasses-message-handler";
export { handleAppMessage, AppErrorCode } from "./app-message-handler";
