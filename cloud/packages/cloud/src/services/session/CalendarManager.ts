/**
 * CalendarManager
 *
 * Session-scoped manager that:
 * - Normalizes calendar events from different sources (WS, REST/Expo)
 * - Caches recent events (max 100) with prioritization (present/future first)
 * - Broadcasts events to subscribed Apps via the legacy calendar_event stream
 *
 * No persistence; cache is in-memory per UserSession.
 */

import type { Logger } from "pino";

import { StreamType, CloudToAppMessageType, type CalendarEvent, type DataStream } from "@mentra/sdk";

import { WebSocketReadyState } from "../websocket/types";

import type UserSession from "./UserSession";

export class CalendarManager {
  private readonly userSession: UserSession;
  private readonly logger: Logger;

  // In-memory session-scoped cache (sorted/prioritized on insert)
  private events: CalendarEvent[] = [];

  // Cache policy
  private static readonly MAX_CACHE = 100;

  // track which apps have received relay (to avoid duplicate relays)
  private subscribedApps: Set<string> = new Set();

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "CalendarManager" });
    this.logger.info({ userId: userSession.userId }, "CalendarManager initialized");
  }

  /**
   * REST entrypoint: update from client (e.g., Expo Calendar Event)
   * - Validates and normalizes payload to SDK CalendarEvent
   * - Adds to cache and broadcasts to subscribed Apps
   */
  async updateEventsFromAPI(expoEvents: any[]): Promise<void> {
    try {
      const normalizedEvents = expoEvents.map((expoEvent) => this.normalizeFromExpo(expoEvent));
      normalizedEvents.forEach((normalized) => {
        if (!normalized) {
          this.logger.warn({ expoEvents }, "Ignored invalid calendar payload from client");
          return;
        }

        this.addEvent(normalized);
        this.broadcast(normalized);
      });
    } catch (error) {
      this.logger.child({ expoEvents }).error(error, "Error updating calendar from client");
    }
  }

  /**
   * WS entrypoint: ingest from glasses (legacy path)
   * - Ensures the message conforms to SDK CalendarEvent
   * - Adds to cache and broadcasts to subscribed Apps
   */
  updateEventFromWebsocket(event: CalendarEvent): void {
    try {
      const normalized = this.normalizeFromGlasses(event);
      this.addEvent(normalized);
      this.broadcast(normalized);
    } catch (error) {
      this.logger.child({ event }).error(error, "Error ingesting calendar event from glasses");
    }
  }

  /**
   * Returns a snapshot of cached events (already prioritized and clamped)
   */
  getCachedEvents(): CalendarEvent[] {
    return [...this.events];
  }

  /**
   * Handle subscription update from SubscriptionManager.
   * Receives list of subscribed app packages and handles relay to newly subscribed apps.
   */
  public handleSubscriptionUpdate(packageNames: string[]): void {
    try {
      // Detect and relay to newly subscribed apps
      const newPackages = packageNames.filter((p) => !this.subscribedApps.has(p));

      for (const packageName of newPackages) {
        this.relayToApp(packageName);
        this.subscribedApps.add(packageName);
      }
    } catch (error) {
      this.logger.error(error, "Error handling calendar subscription update");
    }
  }

  /**
   * Handle app unsubscribe - remove from subscribed apps tracking
   */
  public handleUnsubscribe(packageName: string): void {
    this.subscribedApps.delete(packageName);
    this.logger.debug({ packageName }, "Removed app from calendar subscriptions");
  }

  /**
   * Cleanup manager state (called from UserSession.dispose)
   */
  dispose(): void {
    this.events = [];
    this.subscribedApps.clear();
  }

  // ===== Internals =====

  /**
   * Normalize an Expo Calendar Event payload to SDK CalendarEvent
   */
  private normalizeFromExpo(input: any): CalendarEvent | null {
    if (!input || typeof input !== "object") return null;

    // Try common Expo Calendar event field names
    const id = this.toStringSafe(input.id ?? input.eventId);
    const title = this.toStringSafe(input.title ?? "");
    const start = input.startDate ?? input.start ?? input.dtStart ?? input.start_time;
    const end = input.endDate ?? input.end ?? input.dtEnd ?? input.end_time;
    const tz = this.toStringSafe(input.timeZone ?? input.timezone ?? "");

    if (!id || !title || !start) {
      // Minimal validation: require id, title, start
      return null;
    }

    const dtStart = this.toIsoString(start);
    const dtEnd = this.toIsoString(end ?? start);
    const timeStamp = new Date().toISOString();

    const event: CalendarEvent = {
      type: StreamType.CALENDAR_EVENT,
      eventId: id,
      title,
      dtStart,
      dtEnd,
      timezone: tz,
      timeStamp,
    };

    return event;
  }

  /**
   * Normalize a glasses-originating event to an SDK CalendarEvent
   * Ensures stream type is StreamType.CALENDAR_EVENT for App subscriptions.
   */
  private normalizeFromGlasses(event: CalendarEvent): CalendarEvent {
    const id = this.toStringSafe(event.eventId);
    const title = this.toStringSafe(event.title);
    const dtStart = this.toIsoString(event.dtStart);
    const dtEnd = this.toIsoString(event.dtEnd ?? event.dtStart);
    const tz = this.toStringSafe((event as any).timezone ?? "");
    const timeStamp = this.toIsoString((event as any).timeStamp ?? new Date());

    const normalized: CalendarEvent = {
      type: StreamType.CALENDAR_EVENT,
      eventId: id,
      title,
      dtStart,
      dtEnd,
      timezone: tz,
      timeStamp,
    };
    return normalized;
  }

  /**
   * Add or update an event in the cache and enforce prioritization + max size
   */
  private addEvent(event: CalendarEvent): void {
    // Dedup by eventId + dtStart
    const idx = this.events.findIndex((e) => e.eventId === event.eventId && e.dtStart === event.dtStart);

    if (idx >= 0) {
      this.events[idx] = event; // replace existing
    } else {
      this.events.push(event);
    }

    // Prioritize and clamp cache
    this.prioritizeAndClamp();
    this.logger.debug(
      {
        userId: this.userSession.userId,
        cachedCount: this.events.length,
        lastEvent: {
          eventId: event.eventId,
          title: event.title,
          dtStart: event.dtStart,
          dtEnd: event.dtEnd,
          timezone: event.timezone,
        },
      },
      "Cached calendar event",
    );
  }

  /**
   * Broadcast a single normalized event to Apps subscribed to calendar_event
   */
  private broadcast(event: CalendarEvent): void {
    try {
      this.userSession.relayMessageToApps(event);
    } catch (error) {
      this.logger.child({ event }).error(error, "Error broadcasting calendar event to Apps");
    }
  }

  /**
   * Sort events by:
   * 1) Present/Future (active or starting in future) first
   * 2) Among present/future: ascending start time (soonest first)
   * 3) Among past: descending start time (most recent first)
   * Then clamp to MAX_CACHE
   */
  private prioritizeAndClamp(): void {
    const now = Date.now();

    const sorted = [...this.events].sort((a, b) => {
      const aStart = this.safeTime(a.dtStart);
      const bStart = this.safeTime(b.dtStart);
      const aEnd = this.safeTime(a.dtEnd ?? a.dtStart);
      const bEnd = this.safeTime(b.dtEnd ?? b.dtStart);

      const aIsFutureOrPresent = aStart >= now || (aStart <= now && aEnd >= now);
      const bIsFutureOrPresent = bStart >= now || (bStart <= now && bEnd >= now);

      if (aIsFutureOrPresent !== bIsFutureOrPresent) {
        return aIsFutureOrPresent ? -1 : 1; // future/present first
      }

      if (aIsFutureOrPresent && bIsFutureOrPresent) {
        // both future/present: soonest first
        return aStart - bStart;
      }

      // both past: most recent first
      return bStart - aStart;
    });

    this.events = sorted.slice(0, CalendarManager.MAX_CACHE);
  }

  private toStringSafe(val: unknown): string {
    if (val === null || val === undefined) return "";
    return String(val);
  }

  private toIsoString(val: unknown): string {
    try {
      if (val instanceof Date) return val.toISOString();
      const d = new Date(val as any);
      if (!isNaN(d.valueOf())) return d.toISOString();
    } catch {
      // ignore
    }
    return new Date().toISOString();
  }

  private safeTime(isoLike: string): number {
    const t = Date.parse(isoLike);
    return isNaN(t) ? Date.now() : t;
  }

  /**
   * Relay cached calendar events to a newly subscribed app
   */
  private relayToApp(packageName: string): void {
    const cachedEvents = this.getCachedEvents();

    if (cachedEvents.length === 0) {
      this.logger.debug({ packageName }, "No calendar events to relay to newly subscribed app");
      return;
    }

    const appWebsocket = this.userSession.appWebsockets.get(packageName);
    if (!appWebsocket || appWebsocket.readyState !== WebSocketReadyState.OPEN) {
      this.logger.warn({ packageName }, "App websocket not available for calendar relay");
      return;
    }

    // Send each event as a separate DataStream message
    for (const event of cachedEvents) {
      const dataStream: DataStream = {
        type: CloudToAppMessageType.DATA_STREAM,
        streamType: StreamType.CALENDAR_EVENT,
        sessionId: `${this.userSession.userId}-${packageName}`,
        data: event,
        timestamp: new Date(),
      };
      appWebsocket.send(JSON.stringify(dataStream));
    }

    this.logger.info(
      {
        packageName,
        eventCount: cachedEvents.length,
      },
      "Relayed calendar events to newly subscribed app",
    );
  }
}

export default CalendarManager;
