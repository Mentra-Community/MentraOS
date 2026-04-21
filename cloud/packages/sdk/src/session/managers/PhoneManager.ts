/**
 * PhoneManager — Phone-Scoped Event Management
 *
 * Consolidates all phone-related data streams into a single manager
 * with purpose-built sub-managers:
 *
 * - **notifications** — Phone notification events and dismissals
 * - **calendar** — Calendar event stream
 *
 * Each sub-manager exposes a `hasPermission` getter that delegates to
 * the {@link PermissionsManager}, giving callers a convenient way to
 * check access before subscribing.
 *
 * All handler registrations return a cleanup function. Subscriptions
 * are managed automatically — `addSubscription` is called when the
 * first handler for a stream is registered, and `removeSubscription`
 * when the last handler is removed.
 *
 * @example
 * ```ts
 * // Notifications (with permission check)
 * if (phone.notifications.hasPermission) {
 *   phone.notifications.on((n) => {
 *     console.log(`${n.app}: ${n.title}`);
 *   });
 * }
 *
 * // Calendar events
 * if (phone.calendar.hasPermission) {
 *   phone.calendar.on((event) => {
 *     console.log(event.title, event.start, "→", event.end);
 *   });
 * }
 * ```
 *
 * @module
 */

import { StreamType } from "../../types/streams";
import type { PermissionsManager } from "./PermissionsManager";

// ─── Event Types ────────────────────────────────────────────────────────────

/**
 * Phone notification event delivered from the companion app.
 */
export interface PhoneNotificationEvent {
  /** Unique identifier for this notification. */
  notificationId: string;
  /** Source application package/name. */
  app: string;
  /** Notification title. */
  title: string;
  /** Notification body content. */
  content: string;
  /** Notification priority level. */
  priority: "low" | "normal" | "high";
}

/**
 * Event emitted when a phone notification is dismissed by the user.
 */
export interface NotificationDismissedEvent {
  /** Unique identifier of the dismissed notification. */
  notificationId: string;
  /** Source application package/name. */
  app: string;
  /** Notification title. */
  title: string;
  /** Notification body content. */
  content: string;
  /** Platform-specific notification key. */
  notificationKey: string;
}

/**
 * Normalised calendar event data.
 *
 * Raw wire fields are normalised for a cleaner developer experience:
 * - `dtStart`    → `start`
 * - `dtEnd`      → `end`
 * - `timeStamp`  → `timestamp`
 */
export interface CalendarEventData {
  /** Calendar event identifier. */
  eventId: string;
  /** Event title/summary. */
  title: string;
  /** Normalised start time (ISO string). */
  start: string;
  /** Normalised end time (ISO string). */
  end: string;
  /** Event timezone. */
  timezone: string;
  /** Normalised timestamp of the event update (ISO string). */
  timestamp: string;
  /** Any additional fields from the raw payload. */
  [key: string]: any;
}



// ─── Dependency Types ───────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession into the PhoneManager.
 */
export interface PhoneManagerDeps {
  /** DataStreamRouter — register for stream-type events. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Subscribe to a data stream (sent to cloud). */
  addSubscription: (stream: string) => void;
  /** Unsubscribe from a data stream. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary message to the cloud. */
  sendMessage: (message: any) => void;
  /** Session-scoped logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** Returns the current app's package name. */
  getPackageName: () => string;
  /** Returns the active session ID. */
  getSessionId: () => string;
  /** PermissionsManager for gating protected streams. */
  permissions: PermissionsManager;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Normalise raw calendar event data from the wire format.
 *
 * - `dtStart`    → `start`
 * - `dtEnd`      → `end`
 * - `timeStamp`  → `timestamp`
 */
function normaliseCalendarEvent(raw: any): CalendarEventData {
  return {
    ...raw,
    eventId: raw.eventId ?? raw.event_id ?? "unknown",
    title: raw.title ?? "",
    start: raw.dtStart ?? raw.start ?? "",
    end: raw.dtEnd ?? raw.end ?? "",
    timezone: raw.timezone ?? "",
    timestamp: raw.timeStamp ?? raw.timestamp ?? new Date().toISOString(),
  };
}

// ─── Stream Handler Bookkeeping ─────────────────────────────────────────────

/**
 * Shared ref-counting logic for stream subscriptions.
 *
 * Tracks handler counts per stream key and calls `addSubscription` /
 * `removeSubscription` at the appropriate lifecycle boundaries.
 * Identical pattern to the `addStreamHandler` private method in DeviceManager,
 * extracted here so all three PhoneManager sub-concerns can share it.
 */
class StreamHandlerTracker {
  /** Ref-counted handler totals keyed by stream string. */
  private handlerCounts: Map<string, number> = new Map();

  /** All cleanup functions for bulk teardown. */
  private cleanups: Array<() => void> = [];

  constructor(
    private router: PhoneManagerDeps["router"],
    private addSubscription: PhoneManagerDeps["addSubscription"],
    private removeSubscription: PhoneManagerDeps["removeSubscription"],
  ) {}

  /**
   * Register a handler on the DataStreamRouter for a given stream key,
   * managing subscription lifecycle automatically.
   *
   * - Calls `addSubscription` when the first handler for a key is added.
   * - Calls `removeSubscription` when the last handler for a key is removed.
   *
   * @param streamKey - The stream type string
   * @param handler - The stream handler function
   * @returns Cleanup function that unregisters the handler and manages subscription
   */
  add(streamKey: string, handler: (streamType: string, data: any, message: any) => void): () => void {
    const currentCount = this.handlerCounts.get(streamKey) ?? 0;

    // First handler for this stream — subscribe
    if (currentCount === 0) {
      this.addSubscription(streamKey);
    }
    this.handlerCounts.set(streamKey, currentCount + 1);

    // Register on the router
    const routerCleanup = this.router.on(streamKey, handler);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      // Remove from router
      routerCleanup();

      // Decrement handler count
      const count = this.handlerCounts.get(streamKey) ?? 0;
      const newCount = count - 1;
      if (newCount <= 0) {
        this.handlerCounts.delete(streamKey);
        this.removeSubscription(streamKey);
      } else {
        this.handlerCounts.set(streamKey, newCount);
      }
    };

    this.cleanups.push(cleanup);
    return cleanup;
  }

  /**
   * Remove all tracked handlers and unsubscribe from all streams.
   * Called during session teardown.
   */
  destroyAll(): void {
    for (const fn of this.cleanups) {
      fn();
    }
    this.cleanups.length = 0;
    this.handlerCounts.clear();
  }
}

// ─── NotificationSubManager ─────────────────────────────────────────────────

/**
 * Sub-manager for phone notification streams.
 *
 * Provides handlers for incoming notifications and notification dismissals,
 * plus a convenience `hasPermission` check.
 *
 * @example
 * ```ts
 * if (phone.notifications.hasPermission) {
 *   phone.notifications.on((n) => {
 *     showOnGlasses(`${n.app}: ${n.title}`);
 *   });
 *
 *   phone.notifications.onDismissed((e) => {
 *     removeFromGlasses(e.notificationId);
 *   });
 * }
 * ```
 */
export class NotificationSubManager {
  private permissions: PermissionsManager;
  private tracker: StreamHandlerTracker;
  private logger: PhoneManagerDeps["logger"];

  /** @internal */
  constructor(permissions: PermissionsManager, tracker: StreamHandlerTracker, logger: PhoneManagerDeps["logger"]) {
    this.permissions = permissions;
    this.tracker = tracker;
    this.logger = logger;
  }

  /**
   * Whether the app has the `notifications` permission.
   *
   * Reads from the {@link PermissionsManager} — this is a live check,
   * not a cached value.
   */
  get hasPermission(): boolean {
    return this.permissions.has("notifications");
  }

  /**
   * Listen for incoming phone notifications.
   *
   * @param handler - Called with {@link PhoneNotificationEvent} for each notification
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * const stop = phone.notifications.on((n) => {
   *   console.log(`[${n.priority}] ${n.app}: ${n.title} — ${n.content}`);
   * });
   * ```
   */
  on(handler: (notification: PhoneNotificationEvent) => void): () => void {
    return this.tracker.add(StreamType.PHONE_NOTIFICATION, (_streamType, data) => {
      try {
        handler({
          notificationId: data.notificationId ?? data.notification_id ?? "unknown",
          app: data.app ?? "unknown",
          title: data.title ?? "",
          content: data.content ?? "",
          priority: data.priority ?? "normal",
        });
      } catch (err) {
        this.logger.error(
          `NotificationSubManager: Error in notification handler: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  /**
   * Listen for notification dismissal events.
   *
   * Fired when the user dismisses a notification on their phone.
   *
   * @param handler - Called with {@link NotificationDismissedEvent} for each dismissal
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * phone.notifications.onDismissed((e) => {
   *   console.log("Dismissed:", e.notificationId, "from", e.app);
   * });
   * ```
   */
  onDismissed(handler: (event: NotificationDismissedEvent) => void): () => void {
    return this.tracker.add(StreamType.PHONE_NOTIFICATION_DISMISSED, (_streamType, data) => {
      try {
        handler({
          notificationId: data.notificationId ?? data.notification_id ?? "unknown",
          app: data.app ?? "unknown",
          title: data.title ?? "",
          content: data.content ?? "",
          notificationKey: data.notificationKey ?? data.notification_key ?? "",
        });
      } catch (err) {
        this.logger.error(
          `NotificationSubManager: Error in dismissal handler: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

// ─── CalendarSubManager ─────────────────────────────────────────────────────

/**
 * Sub-manager for calendar event streams.
 *
 * Normalises raw calendar data (e.g. `dtStart` → `start`) and provides
 * a convenience `hasPermission` check.
 *
 * @example
 * ```ts
 * if (phone.calendar.hasPermission) {
 *   phone.calendar.on((event) => {
 *     console.log(`${event.title}: ${event.start} → ${event.end}`);
 *   });
 * }
 * ```
 */
export class CalendarSubManager {
  private permissions: PermissionsManager;
  private tracker: StreamHandlerTracker;
  private logger: PhoneManagerDeps["logger"];

  /** @internal */
  constructor(permissions: PermissionsManager, tracker: StreamHandlerTracker, logger: PhoneManagerDeps["logger"]) {
    this.permissions = permissions;
    this.tracker = tracker;
    this.logger = logger;
  }

  /**
   * Whether the app has the `calendar` permission.
   *
   * Reads from the {@link PermissionsManager} — this is a live check,
   * not a cached value.
   */
  get hasPermission(): boolean {
    return this.permissions.has("calendar");
  }

  /**
   * Listen for calendar events from the phone.
   *
   * Raw fields are normalised:
   * - `dtStart`   → `start`
   * - `dtEnd`     → `end`
   * - `timeStamp` → `timestamp`
   *
   * @param handler - Called with {@link CalendarEventData} for each event
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * const stop = phone.calendar.on((event) => {
   *   console.log(`${event.title} at ${event.start} (${event.timezone})`);
   * });
   * ```
   */
  on(handler: (event: CalendarEventData) => void): () => void {
    return this.tracker.add(StreamType.CALENDAR_EVENT, (_streamType, data) => {
      try {
        handler(normaliseCalendarEvent(data));
      } catch (err) {
        this.logger.error(
          `CalendarSubManager: Error in calendar handler: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}

// ─── PhoneManager ───────────────────────────────────────────────────────────

/**
 * Manages all phone-related data streams for a MentraSession.
 *
 * Exposes sub-managers for notifications and calendar. Created by MentraSession and exposed as
 * `session.phone`.
 */
export class PhoneManager {
  // ─── Sub-Managers ─────────────────────────────────────────────────────

  /** Notification stream sub-manager. */
  readonly notifications: NotificationSubManager;

  /** Calendar event stream sub-manager. */
  readonly calendar: CalendarSubManager;

  // ─── Private ──────────────────────────────────────────────────────────

  private deps: PhoneManagerDeps;
  private permissions: PermissionsManager;
  private tracker: StreamHandlerTracker;

  constructor(deps: PhoneManagerDeps) {
    this.deps = deps;
    this.permissions = deps.permissions;

    // Shared subscription tracker for all phone streams
    this.tracker = new StreamHandlerTracker(deps.router, deps.addSubscription, deps.removeSubscription);

    // Wire up sub-managers
    this.notifications = new NotificationSubManager(this.permissions, this.tracker, deps.logger);
    this.calendar = new CalendarSubManager(this.permissions, this.tracker, deps.logger);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────

  /**
   * Remove all registered handlers and unsubscribe from all streams.
   *
   * Called by MentraSession during disconnect/teardown.
   * @internal
   */
  destroy(): void {
    this.tracker.destroyAll();
    this.deps.logger.debug("PhoneManager: Destroyed.");
  }
}
