/**
 * LocationManager
 *
 * Session-scoped manager that owns in-memory location state, poll coordination,
 * and tier management for a single user session.
 *
 * - Accepts device-originated WebSocket updates and client-originated REST API updates
 * - Supports Expo LocationObjectCoords mapping (latitude/longitude/etc.)
 * - Keeps last known location in memory (source of truth during active session)
 * - DB "cold cache" pattern: read once on init, write once on dispose
 * - Handles one-time poll requests via correlationId routing
 * - Computes and holds an "effective" subscription tier in memory
 * - Issues device commands (SET_LOCATION_TIER / REQUEST_SINGLE_LOCATION) when appropriate
 */

import type { Logger } from "pino";


import { CloudToAppMessageType, CloudToGlassesMessageType, DataStream, LocationUpdate, StreamType } from "@mentra/sdk";

import { User } from "../../models/user.model";
import { WebSocketReadyState } from "../websocket/types";

import type UserSession from "./UserSession";

/**
 * Tier hierarchy for location accuracy (higher index = higher accuracy/frequency)
 * Used to compute the effective tier when multiple apps subscribe with different rates.
 */
const TIER_HIERARCHY = [
  "reduced",
  "threeKilometers",
  "kilometer",
  "hundredMeters",
  "tenMeters",
  "standard",
  "high",
  "realtime",
];

/**
 * Tier freshness policy (max cache age in milliseconds)
 * The order aligns with typical accuracy to freshness expectations.
 */
const TIER_MAX_AGE_MS: Record<string, number> = {
  // Highest frequency/accuracy first
  realtime: 1_000, // 1s
  high: 10_000, // 10s
  standard: 30_000, // 30s
  tenMeters: 30_000, // 30s
  hundredMeters: 60_000, // 1m
  kilometer: 300_000, // 5m
  threeKilometers: 900_000, // 15m
  reduced: 900_000, // 15m
};

type ExpoLocationCoords = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp?: string | number | Date | null;
};

// Full Expo LocationObject (has nested coords)
type ExpoLocationObject = {
  coords: ExpoLocationCoords;
  timestamp?: number | null;
};

type BasicLocation = {
  lat: number;
  lng: number;
  accuracy?: number | null;
  timestamp?: string | number | Date | null;
};

type NormalizedLocation = {
  lat: number;
  lng: number;
  timestamp: Date;
  accuracy?: number | null;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
};

export class LocationManager {
  private readonly userSession: UserSession;
  private readonly logger: Logger;

  // In-memory last known location (extended fields retained for future SDK expansion)
  private lastLocation?: NormalizedLocation;

  // correlationId -> packageName (which app requested a location poll)
  private pendingPolls: Map<string, string> = new Map();

  // current effective subscription tier (computed from all app subscriptions)
  private effectiveTier?: string;

  // track which apps have received relay (to avoid duplicate relays)
  private subscribedApps: Set<string> = new Set();

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "LocationManager" });

    // Seed from DB cold cache (async, non-blocking)
    this.seedFromDatabaseCache().catch((err) => this.logger.warn(err, "Could not seed location from DB cold cache"));

    this.logger.info({ userId: userSession.userId }, "LocationManager initialized");
  }

  /**
   * REST API entrypoint (client → cloud): update location from mobile client
   * Accepts either a BasicLocation or ExpoLocationCoords-like object.
   * If correlationId is associated with a pending poll, sends targeted response to the requesting App.
   * Otherwise, updates lastLocation in-memory and broadcasts to subscribed Apps.
   */
  public async updateFromAPI(
    payload:
      | { location: BasicLocation & { correlationId?: string | null } }
      | { location: ExpoLocationCoords & { correlationId?: string | null } },
  ): Promise<void> {
    try {
      const raw = payload?.location;
      if (!raw || typeof raw !== "object") {
        this.logger.warn({ payload }, "Ignored invalid REST location payload");
        return;
      }

      const correlationId = (raw as any).correlationId ?? null;
      const normalized = this.normalizeFromClient(raw);
      if (!normalized) {
        this.logger.warn({ raw }, "Could not normalize REST location payload");
        return;
      }

      if (correlationId && this.pendingPolls.has(correlationId)) {
        const targetApp = this.pendingPolls.get(correlationId)!;
        this.sendTargetedLocationToApp(normalized, correlationId, targetApp);
        this.pendingPolls.delete(correlationId);
      } else {
        this.lastLocation = normalized;
        this.broadcastLocation(normalized);
      }
    } catch (error) {
      this.logger.error(error as Error, "Error handling REST location update");
    }
  }

  /**
   * WebSocket entrypoint (device → cloud): ingest device-originating LOCATION_UPDATE
   * Supports both targeted poll responses (with correlationId) and broadcast updates.
   */
  public updateFromWebsocket(update: LocationUpdate): void {
    try {
      // Device-originating updates should contain type = LOCATION_UPDATE
      // Targeted response: correlationId present and tracked
      const correlationId = update.correlationId ?? null;

      if (correlationId && this.pendingPolls.has(correlationId)) {
        const targetApp = this.pendingPolls.get(correlationId)!;
        const normalized = this.normalizeFromDevice(update);
        this.sendTargetedLocationToApp(normalized, correlationId, targetApp);
        this.pendingPolls.delete(correlationId);
      } else {
        // Broadcast update
        const normalized = this.normalizeFromDevice(update);
        this.lastLocation = normalized;
        this.broadcastLocation(normalized);
      }
    } catch (error) {
      this.logger.error(error as Error, "Error ingesting location update from device WS");
    }
  }

  /**
   * Request handler for App-initiated single-fix location poll.
   * - If the lastLocation is fresh enough for the requested accuracy, immediately respond.
   * - Otherwise, if device WS is connected, forward a REQUEST_SINGLE_LOCATION to device and record the pending poll.
   * - If device is not available, keep pending and rely on REST client to post a correlated response.
   */
  public async handlePollRequestFromApp(accuracy: string, correlationId: string, packageName: string): Promise<void> {
    try {
      // If we already have a fresh-enough cached location, respond immediately
      if (this.lastLocation && this.isFreshEnough(this.lastLocation, accuracy)) {
        this.sendTargetedLocationToApp(this.lastLocation, correlationId, packageName);
        return;
      }

      // Otherwise, command device if possible
      if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
        this.pendingPolls.set(correlationId, packageName);
        this.sendDeviceCommand(CloudToGlassesMessageType.REQUEST_SINGLE_LOCATION, {
          accuracy,
          correlationId,
        });
        this.logger.info(
          {
            userId: this.userSession.userId,
            accuracy,
            correlationId,
            packageName,
          },
          "Requested single location from device",
        );
      } else {
        // No device WS connection. Record as pending and expect REST client to satisfy it.
        this.pendingPolls.set(correlationId, packageName);
        this.logger.warn(
          {
            userId: this.userSession.userId,
            accuracy,
            correlationId,
            packageName,
          },
          "Device WS not available; poll request recorded pending; expecting REST update",
        );
      }
    } catch (error) {
      this.logger.error(error as Error, "Error handling App location poll request");
    }
  }

  /**
   * Replays the last known location for apps that have just subscribed to location_update.
   */
  public getLastLocation(): LocationUpdate | undefined {
    if (!this.lastLocation) return undefined;
    return this.toSdkLocationUpdate(this.lastLocation);
  }

  /**
   * Handle subscription change: update effective tier in-memory
   * and optionally send a tier command to device if connected.
   */
  public onSubscriptionChange(newEffectiveTier: string | null | undefined): void {
    try {
      const desiredTier = newEffectiveTier ?? "reduced";
      if (this.effectiveTier === desiredTier) {
        this.logger.debug({ userId: this.userSession.userId, tier: desiredTier }, "Location effective tier unchanged");
        return;
      }

      this.effectiveTier = desiredTier;
      // If device is connected, set the new tier
      if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
        this.sendDeviceCommand(CloudToGlassesMessageType.SET_LOCATION_TIER, {
          tier: desiredTier,
        });
        this.logger.info({ userId: this.userSession.userId, tier: desiredTier }, "Issued SET_LOCATION_TIER to device");
      } else {
        this.logger.warn(
          { userId: this.userSession.userId, tier: desiredTier },
          "Device WS not available to send SET_LOCATION_TIER; tier kept in-memory",
        );
      }
    } catch (error) {
      this.logger.error(error as Error, "Error handling location subscription change");
    }
  }

  /**
   * Handle subscription update from SubscriptionManager.
   * Receives raw location subscription data and computes effective tier.
   * Also handles relay to newly subscribed apps.
   */
  public handleSubscriptionUpdate(subs: Array<{ packageName: string; rate: string }>): void {
    try {
      // Detect and relay to newly subscribed apps
      const newPackages = subs.filter((s) => !this.subscribedApps.has(s.packageName));

      for (const sub of newPackages) {
        this.relayToApp(sub.packageName);
        this.subscribedApps.add(sub.packageName);
      }

      // Extract rates from subscription data
      const rates = subs.map((s) => s.rate);

      // Compute new effective tier
      const newTier = this.computeEffectiveTier(rates);

      // Only update if tier changed
      if (this.effectiveTier !== newTier) {
        this.logger.info(
          {
            userId: this.userSession.userId,
            oldTier: this.effectiveTier,
            newTier,
            appCount: subs.length,
          },
          "Location effective tier changed",
        );
        this.onSubscriptionChange(newTier);
      }
    } catch (error) {
      this.logger.error(error, "Error handling location subscription update");
    }
  }

  /**
   * Handle app unsubscribe - remove from subscribed apps tracking
   */
  public handleUnsubscribe(packageName: string): void {
    this.subscribedApps.delete(packageName);
    this.logger.debug({ packageName }, "Removed app from location subscriptions");
  }

  /**
   * Explicitly set the effective tier (in-memory), typically from a higher-level subscription manager.
   * @deprecated Use handleSubscriptionUpdate instead
   */
  public setEffectiveTier(tier: string): void {
    this.onSubscriptionChange(tier);
  }

  /**
   * Cleanup internal state on session dispose and persist to DB cold cache
   */
  public async dispose(): Promise<void> {
    // Persist to DB cold cache for next session
    if (this.lastLocation) {
      try {
        const user = await User.findOne({ email: this.userSession.userId });
        if (user) {
          user.location = {
            lat: this.lastLocation.lat,
            lng: this.lastLocation.lng,
            accuracy: this.lastLocation.accuracy ?? undefined,
            timestamp: this.lastLocation.timestamp,
          };
          await user.save();
          this.logger.info("Persisted lastLocation to DB cold cache");
        }
      } catch (error) {
        this.logger.warn(error, "Failed to persist location to DB cold cache");
      }
    }

    // Clear in-memory state
    this.pendingPolls.clear();
    this.subscribedApps.clear();
    this.lastLocation = undefined;
    this.effectiveTier = undefined;

    this.logger.info({ userId: this.userSession.userId }, "LocationManager disposed");
  }

  // ===== Internal helpers =====

  /**
   * Relay cached location to a newly subscribed app
   */
  private relayToApp(packageName: string): void {
    if (!this.lastLocation) {
      this.logger.debug({ packageName }, "No location to relay to newly subscribed app");
      return;
    }

    const appWebsocket = this.userSession.appWebsockets.get(packageName);
    if (!appWebsocket || appWebsocket.readyState !== WebSocketReadyState.OPEN) {
      this.logger.warn({ packageName }, "App websocket not available for location relay");
      return;
    }

    const locationUpdate = this.toSdkLocationUpdate(this.lastLocation);
    const dataStream: DataStream = {
      type: CloudToAppMessageType.DATA_STREAM,
      sessionId: `${this.userSession.userId}-${packageName}`,
      streamType: StreamType.LOCATION_UPDATE,
      data: locationUpdate,
      timestamp: new Date(),
    };

    appWebsocket.send(JSON.stringify(dataStream));
    this.logger.info(
      {
        packageName,
        location: { lat: this.lastLocation.lat, lng: this.lastLocation.lng },
      },
      "Relayed location to newly subscribed app",
    );
  }

  /**
   * Compute the effective location tier from an array of rates.
   * Returns the highest tier (most accurate/frequent) requested by any app.
   */
  private computeEffectiveTier(rates: string[]): string {
    const defaultTier = "reduced";

    if (rates.length === 0) {
      return defaultTier;
    }

    // Find the highest tier (highest index in TIER_HIERARCHY)
    let highestTierIndex = -1;
    for (const rate of rates) {
      const tierIndex = TIER_HIERARCHY.indexOf(rate);
      if (tierIndex > highestTierIndex) {
        highestTierIndex = tierIndex;
      }
    }

    return highestTierIndex > -1 ? TIER_HIERARCHY[highestTierIndex] : defaultTier;
  }

  /**
   * Seed lastLocation from DB cold cache on session init (one-time read)
   */
  private async seedFromDatabaseCache(): Promise<void> {
    try {
      const user = await User.findOne({ email: this.userSession.userId });
      if (user?.location?.lat && user?.location?.lng) {
        this.lastLocation = {
          lat: user.location.lat,
          lng: user.location.lng,
          accuracy: user.location.accuracy ?? null,
          timestamp: user.location.timestamp instanceof Date ? user.location.timestamp : new Date(),
        };
        this.logger.info("Seeded lastLocation from DB cold cache");
      }
    } catch (error) {
      this.logger.warn(error, "Failed to seed location from DB cold cache");
    }
  }

  private isFreshEnough(loc: NormalizedLocation, requestedTier: string): boolean {
    const maxAge = TIER_MAX_AGE_MS[requestedTier] ?? TIER_MAX_AGE_MS["reduced"];
    const ageMs = Date.now() - loc.timestamp.getTime();
    return ageMs <= maxAge;
  }

  private broadcastLocation(loc: NormalizedLocation): void {
    try {
      const update = this.toSdkLocationUpdate(loc);
      this.userSession.relayMessageToApps(update);
      this.logger.debug(
        {
          userId: this.userSession.userId,
          lat: loc.lat,
          lng: loc.lng,
          accuracy: loc.accuracy,
        },
        "Broadcasted location update to subscribed apps",
      );
    } catch (error) {
      this.logger.error(error as Error, "Error broadcasting location to apps");
    }
  }

  private sendTargetedLocationToApp(loc: NormalizedLocation, correlationId: string, packageName: string): void {
    try {
      const appWs = this.userSession.appWebsockets.get(packageName);
      if (!appWs || appWs.readyState !== WebSocketReadyState.OPEN) {
        this.logger.warn(
          { userId: this.userSession.userId, packageName, correlationId },
          "Target App websocket not available for location poll response",
        );
        return;
      }

      const update = this.toSdkLocationUpdate(loc, correlationId);
      const dataStream: DataStream = {
        type: CloudToAppMessageType.DATA_STREAM,
        streamType: StreamType.LOCATION_UPDATE,
        sessionId: `${this.userSession.sessionId}-${packageName}`,
        data: update,
        timestamp: new Date(),
      };
      appWs.send(JSON.stringify(dataStream));
      this.logger.info(
        { userId: this.userSession.userId, packageName, correlationId },
        "Sent targeted location poll response to App",
      );
    } catch (error) {
      this.logger.error(error as Error, "Error sending targeted location to App");
    }
  }

  private sendDeviceCommand(type: CloudToGlassesMessageType, payload: Record<string, unknown>): void {
    try {
      if (!this.userSession.websocket || this.userSession.websocket.readyState !== WebSocketReadyState.OPEN) {
        this.logger.warn({ userId: this.userSession.userId, type }, "Cannot send device command; WS not available");
        return;
      }

      let message: any;
      switch (type) {
        case CloudToGlassesMessageType.SET_LOCATION_TIER:
          message = {
            type: CloudToGlassesMessageType.SET_LOCATION_TIER,
            tier: payload.tier,
            timestamp: new Date(),
          };
          break;
        case CloudToGlassesMessageType.REQUEST_SINGLE_LOCATION:
          message = {
            type: CloudToGlassesMessageType.REQUEST_SINGLE_LOCATION,
            accuracy: payload.accuracy,
            correlationId: payload.correlationId,
            timestamp: new Date(),
          };
          break;
        default:
          this.logger.warn({ type }, "Unhandled device command type");
          return;
      }

      this.userSession.websocket.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error(error as Error, "Error sending device command");
    }
  }

  private toSdkLocationUpdate(loc: NormalizedLocation, correlationId?: string | null): LocationUpdate {
    // Only include fields supported by current SDK LocationUpdate
    const update: LocationUpdate = {
      type: StreamType.LOCATION_UPDATE,
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy ?? undefined,
      timestamp: new Date(),
    };
    if (correlationId) update.correlationId = correlationId;
    return update;
  }

  private normalizeFromClient(raw: BasicLocation | ExpoLocationCoords | ExpoLocationObject): NormalizedLocation | null {
    try {
      // Expo LocationObject format (with nested coords)
      if ("coords" in raw && raw.coords && typeof raw.coords === "object") {
        const coords = raw.coords as ExpoLocationCoords;
        const lat = Number(coords.latitude);
        const lng = Number(coords.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return null;

        // Timestamp can be on the outer object or in coords
        const timestamp = this.coerceTimestamp(raw.timestamp ?? coords.timestamp);
        return {
          lat,
          lng,
          timestamp,
          accuracy: this.toNumberOrNull(coords.accuracy),
          altitude: this.toNumberOrNull(coords.altitude),
          altitudeAccuracy: this.toNumberOrNull(coords.altitudeAccuracy),
          heading: this.toNumberOrNull(coords.heading),
          speed: this.toNumberOrNull(coords.speed),
        };
      }

      // Expo coords directly (latitude/longitude at top level)
      if ("latitude" in raw && "longitude" in raw) {
        const lat = Number(raw.latitude);
        const lng = Number(raw.longitude);
        if (!isFinite(lat) || !isFinite(lng)) return null;

        const timestamp = this.coerceTimestamp((raw as ExpoLocationCoords).timestamp);
        return {
          lat,
          lng,
          timestamp,
          accuracy: this.toNumberOrNull((raw as ExpoLocationCoords).accuracy),
          altitude: this.toNumberOrNull((raw as ExpoLocationCoords).altitude),
          altitudeAccuracy: this.toNumberOrNull((raw as ExpoLocationCoords).altitudeAccuracy),
          heading: this.toNumberOrNull((raw as ExpoLocationCoords).heading),
          speed: this.toNumberOrNull((raw as ExpoLocationCoords).speed),
        };
      }

      // Basic payload
      if ("lat" in raw && "lng" in raw) {
        const lat = Number((raw as BasicLocation).lat);
        const lng = Number((raw as BasicLocation).lng);
        if (!isFinite(lat) || !isFinite(lng)) return null;

        const timestamp = this.coerceTimestamp((raw as BasicLocation).timestamp);
        return {
          lat,
          lng,
          timestamp,
          accuracy: this.toNumberOrNull((raw as BasicLocation).accuracy),
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private normalizeFromDevice(update: LocationUpdate): NormalizedLocation {
    const lat = Number(update.lat);
    const lng = Number(update.lng);
    const accuracy = typeof update.accuracy === "number" ? update.accuracy : null;
    return {
      lat,
      lng,
      accuracy,
      timestamp: new Date(),
    };
  }

  private coerceTimestamp(ts: string | number | Date | null | undefined): Date {
    if (ts instanceof Date) return ts;
    if (typeof ts === "number") {
      const d = new Date(ts);
      if (!isNaN(d.valueOf())) return d;
    }
    if (typeof ts === "string") {
      const d = new Date(ts);
      if (!isNaN(d.valueOf())) return d;
    }
    return new Date();
  }

  private toNumberOrNull(val: unknown): number | null {
    if (val === null || val === undefined) return null;
    const num = Number(val);
    return isFinite(num) ? num : null;
  }
}

export default LocationManager;
