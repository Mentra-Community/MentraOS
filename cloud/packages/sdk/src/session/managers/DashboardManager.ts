/**
 * 📊 DashboardManager — v3 SDK Dashboard Content API
 *
 * Thin wrapper that sends dashboard content updates to the cloud.
 * Provides a simplified two-method API: {@link showText} and {@link clear}.
 *
 * Wire format is identical to v2 DashboardContentManager:
 * ```json
 * {
 *   "type": "dashboard_content_update",
 *   "packageName": "<packageName>",
 *   "sessionId": "<sessionId>-<packageName>",
 *   "content": "<text>",
 *   "modes": ["main"],
 *   "timestamp": "<ISO date>"
 * }
 * ```
 *
 * The `sessionId` field in dashboard messages uses the composite format
 * `"<sessionId>-<packageName>"` to match the v2 wire format exactly.
 *
 * @module
 */

import { AppToCloudMessageType } from "../../types/message-types";
import { DashboardMode, DashboardContentUpdate } from "../../types/dashboard";

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * Structural type — no concrete imports so the manager stays unit-testable
 * with plain stubs.
 */
export interface DashboardManagerDeps {
  /** DataStreamRouter — register for DATA_STREAM messages by streamType key. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Add a subscription string (triggers SUBSCRIPTION_UPDATE to cloud). */
  addSubscription: (stream: string) => void;
  /** Remove a subscription string. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary JSON message over the WebSocket. */
  sendMessage: (message: any) => void;
  /** Structured logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** Package name for outgoing messages. */
  getPackageName: () => string;
  /** Current session ID. */
  getSessionId: () => string;
}

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Controls the dashboard content displayed for this app on the user's glasses.
 *
 * Dashboard content is a text overlay shown in the main dashboard view.
 * The {@link showText} method sends content targeting the `MAIN` dashboard
 * mode by default. Use {@link clear} to remove any displayed content.
 *
 * All methods are fire-and-forget — the messages are sent immediately and
 * no response is awaited.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Show a single line of text
 * session.dashboard.showText("Meeting in 5 minutes");
 *
 * // Show multiple lines
 * session.dashboard.showText(["Line 1", "Line 2", "Line 3"]);
 *
 * // Clear the dashboard
 * session.dashboard.clear();
 * ```
 */
export class DashboardManager {
  private readonly deps: DashboardManagerDeps;

  constructor(deps: DashboardManagerDeps) {
    this.deps = deps;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Show text content on the dashboard.
   *
   * Sends a `dashboard_content_update` message targeting the `MAIN`
   * dashboard mode. Accepts either a single string or an array of
   * pre-wrapped lines — when an array is provided the lines are joined
   * with newlines before sending.
   *
   * @param text - A string or array of strings to display on the dashboard.
   *
   * @example
   * ```ts
   * // Single string
   * session.dashboard.showText("Status: Connected");
   *
   * // Pre-wrapped lines
   * session.dashboard.showText([
   *   "Temperature: 72°F",
   *   "Humidity: 45%",
   *   "Wind: 5 mph",
   * ]);
   * ```
   */
  showText(text: string | string[]): void {
    const content = Array.isArray(text) ? text.join("\n") : text;

    const message: DashboardContentUpdate = {
      type: AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName: this.deps.getPackageName(),
      sessionId: `${this.deps.getSessionId()}-${this.deps.getPackageName()}`,
      content,
      modes: [DashboardMode.MAIN],
      timestamp: new Date(),
    };

    this.deps.sendMessage(message);

    this.deps.logger.debug({ contentLength: content.length }, "📊 Dashboard content update sent");
  }

  /**
   * Clear the dashboard content.
   *
   * Sends an empty `dashboard_content_update` message targeting the
   * `MAIN` dashboard mode, which removes any currently displayed content
   * for this app.
   *
   * @example
   * ```ts
   * session.dashboard.clear();
   * ```
   */
  clear(): void {
    const message: DashboardContentUpdate = {
      type: AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
      packageName: this.deps.getPackageName(),
      sessionId: `${this.deps.getSessionId()}-${this.deps.getPackageName()}`,
      content: "",
      modes: [DashboardMode.MAIN],
      timestamp: new Date(),
    };

    this.deps.sendMessage(message);

    this.deps.logger.debug("📊 Dashboard content cleared");
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Clean up resources.
   *
   * Called by MentraSession during disconnect/cleanup. Dashboard commands
   * are fire-and-forget so there is no pending state to drain.
   *
   * @internal
   */
  destroy(): void {
    this.deps.logger.debug("[DashboardManager] Destroyed.");
  }
}
