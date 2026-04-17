/**
 * 🖥️ DisplayManager — AR Display Control
 *
 * v3 manager that wraps the existing LayoutManager display functionality.
 * Sends DisplayRequest messages to the cloud with identical wire format
 * to ensure backward compatibility.
 *
 * @example
 * ```ts
 * const display = new DisplayManager(deps);
 *
 * // Simple text
 * display.showText("Hello AR World!");
 *
 * // Pre-wrapped lines
 * display.showText(["Line 1", "Line 2"]);
 *
 * // Structured layouts
 * display.showReferenceCard("Weather", "Sunny and 75°F");
 * display.showDashboardCard("BPM", "72");
 *
 * // Clear the display
 * display.clear();
 * ```
 */

import {
  DisplayRequest,
  Layout,
  TextWall,
  DoubleTextWall,
  ReferenceCard,
  DashboardCard,
  BitmapView,
  ClearView,
} from "../../types/layouts";
import { LayoutType, ViewType } from "../../types/enums";
import { AppToCloudMessageType } from "../../types/message-types";

// ─── Dependencies ────────────────────────────────────────────────────────────

/**
 * Shared dependency bag injected by MentraSession.
 * Keeps managers decoupled from the session implementation.
 */
export interface ManagerDeps {
  /** DataStreamRouter — register for DATA_STREAM messages by streamType key. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  addSubscription: (stream: string) => void;
  removeSubscription: (stream: string) => void;
  sendMessage: (message: any) => void;
  sendBinary: (data: ArrayBuffer | Uint8Array) => void;
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  getPackageName: () => string;
  getSessionId: () => string;
}

// ─── DisplayManager ─────────────────────────────────────────────────────────

/**
 * Controls the AR display on the user's glasses.
 *
 * Provides high-level methods for showing text, cards, bitmaps, and
 * clearing the display. All methods produce a `DisplayRequest` message
 * with `type: "display_event"` — the exact same wire format the cloud
 * and glasses firmware already understand from v2.
 */
export class DisplayManager {
  private readonly deps: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  // ─── High-Level API ──────────────────────────────────────────────────────

  /**
   * Show text on the AR display.
   *
   * Accepts a single string or an array of pre-wrapped lines.
   * When an array is provided the lines are joined with newlines
   * and sent as a single TextWall layout.
   *
   * @param text - A string or array of strings to display
   *
   * @example
   * ```ts
   * display.showText("Connected to server");
   * display.showText(["Line 1", "Line 2", "Line 3"]);
   * ```
   */
  showText(text: string | string[]): void {
    const resolved = Array.isArray(text) ? text.join("\n") : text;
    this.showTextWall(resolved);
  }

  /**
   * 📝 Show a single block of text on the main display.
   *
   * Best for simple messages, status updates, and notifications.
   *
   * @param text - Text content to display
   *
   * @example
   * ```ts
   * display.showTextWall("Listening…");
   * ```
   */
  showTextWall(text: string): void {
    if (text === undefined || text === null) {
      text = "";
      this.deps.logger.warn("showTextWall called with null/undefined text");
    }

    if (typeof text !== "string") {
      text = String(text);
      this.deps.logger.warn("showTextWall: non-string input converted to string");
    }

    const layout: TextWall = {
      layoutType: LayoutType.TEXT_WALL,
      text,
    };

    try {
      this.sendDisplayEvent(layout);
    } catch (err) {
      this.deps.logger.error("Failed to display text wall:", err);
    }
  }

  /**
   * ↕️ Show two sections of text, one above the other.
   *
   * Best for before/after content, question/answer, translations,
   * or any two-part message.
   *
   * @param leftText  - Text for the top section
   * @param rightText - Text for the bottom section
   *
   * @example
   * ```ts
   * display.showDoubleTextWall("Original: Hello", "Translated: Bonjour");
   * ```
   */
  showDoubleTextWall(leftText: string, rightText: string): void {
    const layout: DoubleTextWall = {
      layoutType: LayoutType.DOUBLE_TEXT_WALL,
      topText: leftText,
      bottomText: rightText,
    };
    this.sendDisplayEvent(layout);
  }

  /**
   * 📇 Show a card with a title and body text.
   *
   * Best for titled content, important information, and notifications
   * with context.
   *
   * @param title - Card title
   * @param body  - Main content text
   *
   * @example
   * ```ts
   * display.showReferenceCard("Meeting Reminder", "Team standup in 5 minutes");
   * ```
   */
  showReferenceCard(title: string, body: string): void {
    const layout: ReferenceCard = {
      layoutType: LayoutType.REFERENCE_CARD,
      title,
      text: body,
    };
    this.sendDisplayEvent(layout);
  }

  /**
   * 📊 Show a dashboard card with left and right text.
   *
   * Best for key-value pairs, metrics, and dashboard-style displays.
   * Automatically uses the DASHBOARD view type.
   *
   * @param leftText  - Left side text (typically label/key)
   * @param rightText - Right side text (typically value)
   *
   * @example
   * ```ts
   * display.showDashboardCard("Weather", "72°F");
   * ```
   */
  showDashboardCard(leftText: string, rightText: string): void {
    const layout: DashboardCard = {
      layoutType: LayoutType.DASHBOARD_CARD,
      leftText,
      rightText,
    };
    this.sendDisplayEvent(layout, ViewType.DASHBOARD);
  }

  /**
   * 🖼️ Show a bitmap image on the display.
   *
   * @param data - Hex or base64 encoded bitmap data string
   *
   * @example
   * ```ts
   * display.showBitmap(base64EncodedBitmapString);
   * ```
   */
  showBitmap(data: any): void {
    if (typeof data !== "string") {
      this.deps.logger.error("showBitmap: data must be a string");
      return;
    }

    if (data.length > 1_000_000) {
      this.deps.logger.error("showBitmap: data exceeds 1 MB limit");
      return;
    }

    const layout: BitmapView = {
      layoutType: LayoutType.BITMAP_VIEW,
      data,
    };
    this.sendDisplayEvent(layout);
  }

  /**
   * 🧹 Clear the AR display.
   *
   * Removes any currently shown content from the main view.
   *
   * @example
   * ```ts
   * display.clear();
   * ```
   */
  clear(): void {
    const layout: ClearView = {
      layoutType: LayoutType.CLEAR_VIEW,
    };
    this.sendDisplayEvent(layout);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  /**
   * Build and send a DisplayRequest message.
   *
   * Wire format is identical to v2 LayoutManager — the cloud receives
   * the same `{ type: "display_event", packageName, view, layout, … }`.
   *
   * @param layout    - The layout configuration to display
   * @param view      - View type (main or dashboard), defaults to MAIN
   * @param durationMs - Optional display duration in milliseconds
   */
  private sendDisplayEvent(layout: Layout, view: ViewType = ViewType.MAIN, durationMs?: number): void {
    if (!layout || !layout.layoutType) {
      this.deps.logger.error("sendDisplayEvent: layout must have a layoutType property");
      return;
    }

    // Validate view type
    if (view !== ViewType.MAIN && view !== ViewType.DASHBOARD) {
      this.deps.logger.warn(`Invalid view type: ${view}, defaulting to MAIN`);
      view = ViewType.MAIN;
    }

    // Validate duration
    if (durationMs !== undefined) {
      if (typeof durationMs !== "number" || durationMs < 0) {
        this.deps.logger.warn(`Invalid duration: ${durationMs}, ignoring`);
        durationMs = undefined;
      }
    }

    const message: DisplayRequest = {
      timestamp: new Date(),
      sessionId: this.deps.getSessionId(),
      type: AppToCloudMessageType.DISPLAY_REQUEST,
      packageName: this.deps.getPackageName(),
      view,
      layout,
      durationMs,
    };

    this.deps.sendMessage(message);
  }
}
