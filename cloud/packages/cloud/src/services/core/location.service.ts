import {
  CloudToGlassesMessageType,
  LocationUpdate,
  SetLocationTier,
  RequestSingleLocation,
  DataStream,
  CloudToAppMessageType,
  StreamType,
} from "@mentra/sdk";

import { User, UserI } from "../../models/user.model";
import { logger as rootLogger } from "../logging/pino-logger";
import UserSession from "../session/UserSession";
// import subscriptionService from '../session/subscription.service';
import { IWebSocket, WebSocketReadyState } from "../websocket/types";

const logger = rootLogger.child({ service: "location.service" });

// The order of this array defines the priority. 'realtime' is highest.
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

// Defines the maximum age of a cached location for a given accuracy tier before a hardware poll is required.
const TIER_DEFINITIONS: Record<string, { maxCacheAge: number }> = {
  realtime: { maxCacheAge: 1000 }, // 1 second
  high: { maxCacheAge: 10000 }, // 10 seconds
  standard: { maxCacheAge: 30000 }, // 30 seconds (assuming standard is a mid-tier)
  tenMeters: { maxCacheAge: 30000 }, // 30 seconds
  hundredMeters: { maxCacheAge: 60000 }, // 1 minute
  kilometer: { maxCacheAge: 300000 }, // 5 minutes
  threeKilometers: { maxCacheAge: 900000 }, // 15 minutes
  reduced: { maxCacheAge: 900000 }, // 15 minutes
};

class LocationService {
  private pendingPolls = new Map<string, string>(); // correlationId -> packageName

  /**
   * Main entry point for the streaming arbitration logic.
   * Called when a TPA's subscriptions change.
   */
  public async handleSubscriptionChange(user: UserI, userSession: UserSession): Promise<void> {
    const { userId } = userSession;

    const previousEffectiveTier = user.effectiveLocationTier || "reduced";
    const newEffectiveTier = this._calculateEffectiveRateForUser(user);

    if (newEffectiveTier !== previousEffectiveTier) {
      logger.info(
        { userId, oldTier: previousEffectiveTier, newTier: newEffectiveTier },
        "Effective location tier has changed. Updating database and commanding device.",
      );

      // Persist the new effective rate to the database
      user.effectiveLocationTier = newEffectiveTier;

      try {
        await user.save();
        // Send the command to the physical device only after successful save
        if (userSession?.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
          this._sendCommandToDevice(userSession.websocket, CloudToGlassesMessageType.SET_LOCATION_TIER, {
            tier: newEffectiveTier,
          });
        } else {
          logger.warn({ userId }, "User session or WebSocket not available to send location tier command.");
        }
      } catch (error) {
        logger.error({ userId, error }, "Failed to save new effective location tier.");
      }
    } else {
      logger.debug(
        { userId, tier: newEffectiveTier },
        "Location subscriptions changed, but effective tier remains the same. No command sent.",
      );
    }
  }

  /**
   * Main entry point for the intelligent polling logic.
   * Called when a TPA requests a single location fix.
   */
  public async handlePollRequest(
    userSession: UserSession,
    accuracy: string,
    correlationId: string,
    packageName: string,
  ): Promise<void> {
    const { userId } = userSession;

    // Track which app made this poll request
    this.pendingPolls.set(correlationId, packageName);

    const user = await User.findOne({ email: userId });
    if (!user) {
      logger.warn({ userId }, "User not found during location poll request.");
      return;
    }

    // Step 1: Check for an active high-accuracy stream
    const currentEffectiveTier = user.effectiveLocationTier || "reduced";
    const highAccuracyStreamRunning = TIER_HIERARCHY.indexOf(currentEffectiveTier) >= TIER_HIERARCHY.indexOf("high");

    if (highAccuracyStreamRunning && user.location?.timestamp) {
      // If the stream is running, we can use the very latest location data.
      // We assume the handleDeviceLocationUpdate method is keeping the user.location fresh.
      logger.info({ userId, accuracy }, "Fulfilling poll request from active high-accuracy stream.");
      this._sendPollResponseToTpa(userSession, user.location, correlationId, packageName);
      return;
    }

    // Step 2: Check cache against requested accuracy's max age
    const maxCacheAge = TIER_DEFINITIONS[accuracy]?.maxCacheAge;
    if (maxCacheAge !== undefined && user.location?.timestamp) {
      const cacheAge = Date.now() - new Date(user.location.timestamp).getTime();
      if (cacheAge <= maxCacheAge) {
        logger.info({ userId, accuracy, cacheAge, maxCacheAge }, "Fulfilling poll request from cache.");
        this._sendPollResponseToTpa(userSession, user.location, correlationId, packageName);
        return;
      }
    }

    // Step 3: Trigger hardware poll if cache is stale or non-existent
    if (userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
      logger.info({ userId, accuracy }, "No active stream or fresh cache, requesting hardware poll.");
      this._sendCommandToDevice(userSession.websocket, CloudToGlassesMessageType.REQUEST_SINGLE_LOCATION, {
        accuracy,
        correlationId,
      });
    } else {
      logger.warn({ userId }, "User session or WebSocket not available to send hardware poll command.");
    }
  }

  /**
   * Handles an incoming location update from the native device.
   * Updates the user's cached location and forwards poll responses.
   */
  public async handleDeviceLocationUpdate(userSession: UserSession, locationUpdate: LocationUpdate): Promise<void> {
    const { userId } = userSession;

    // If the update has a correlationId, it's a response to a poll request.
    const targetApp = locationUpdate.correlationId ? this.pendingPolls.get(locationUpdate.correlationId) : undefined;

    if (targetApp && locationUpdate.correlationId) {
      // This is a targeted response to a poll.
      const locationWithTimestamp = {
        ...locationUpdate,
        timestamp: new Date(),
      };
      this._sendPollResponseToTpa(userSession, locationWithTimestamp, locationUpdate.correlationId, targetApp);
      this.pendingPolls.delete(locationUpdate.correlationId);
    } else {
      // This is a broadcast update for a continuous stream.
      userSession.relayMessageToApps(locationUpdate);
    }

    // Always update the user's last known location cache in the background.
    (async () => {
      try {
        const user = await User.findOne({ email: userId });
        if (user) {
          user.location = {
            lat: locationUpdate.lat,
            lng: locationUpdate.lng,
            accuracy: locationUpdate.accuracy,
            timestamp: new Date(),
          };
          await user.save();
        }
      } catch (error) {
        logger.error({ userId, error }, "Failed to save user location cache after device update.");
      }
    })();
  }

  /**
   * Calculates the highest tier requested by any of the user's active TPAs.
   */
  private _calculateEffectiveRateForUser(user: UserI): string {
    const defaultRate = "reduced";
    const subscriptions = user.locationSubscriptions;

    if (!subscriptions || subscriptions.size === 0) {
      return defaultRate;
    }

    // The most robust way to iterate over a MongooseMap is to first
    // explicitly convert its values to a standard JavaScript Array.
    const subscriptionDetails = Array.from(subscriptions.values());

    let highestTierIndex = -1;

    for (const subDetails of subscriptionDetails) {
      if (subDetails && subDetails.rate) {
        const tierIndex = TIER_HIERARCHY.indexOf(subDetails.rate);
        if (tierIndex > highestTierIndex) {
          highestTierIndex = tierIndex;
        }
      }
    }

    return highestTierIndex > -1 ? TIER_HIERARCHY[highestTierIndex] : defaultRate;
  }

  /**
   * Relays a location update back to the requesting TPA.
   */
  private _sendPollResponseToTpa(
    userSession: UserSession,
    location: any,
    correlationId: string,
    targetApp: string,
  ): void {
    const locationUpdate: LocationUpdate = {
      type: StreamType.LOCATION_UPDATE,
      lat: location.lat,
      lng: location.lng,
      accuracy: location.accuracy,
      timestamp: new Date(),
      correlationId: correlationId,
    };

    const appWs = userSession.appWebsockets.get(targetApp);
    if (appWs && appWs.readyState === WebSocketReadyState.OPEN) {
      const dataStream: DataStream = {
        type: CloudToAppMessageType.DATA_STREAM,
        sessionId: `${userSession.sessionId}-${targetApp}`,
        streamType: StreamType.LOCATION_UPDATE,
        data: locationUpdate,
        timestamp: new Date(),
      };
      appWs.send(JSON.stringify(dataStream));
      logger.info(
        { userId: userSession.userId, packageName: targetApp, correlationId },
        "Sent location poll response to TPA.",
      );
    } else {
      logger.warn(
        { userId: userSession.userId, packageName: targetApp },
        "Could not send poll response, app websocket not available.",
      );
    }
  }

  /**
   * Sends a command to the device's native WebSocket connection.
   */
  private _sendCommandToDevice(ws: IWebSocket, type: CloudToGlassesMessageType, payload: any): void {
    try {
      let message: SetLocationTier | RequestSingleLocation;

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
          logger.error({ type }, "Attempted to send unknown command type to device.");
          return;
      }

      ws.send(JSON.stringify(message));
      logger.info({ type, payload }, "Successfully sent command to device.");
    } catch (error) {
      logger.error({ error, type }, "Failed to send command to device.");
    }
  }
}

export const locationService = new LocationService();
logger.info("Location Service initialized.");
