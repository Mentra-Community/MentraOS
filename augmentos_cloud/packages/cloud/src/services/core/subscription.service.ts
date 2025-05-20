/**
 * @fileoverview Service for managing TPA subscriptions to data streams.
 * Handles subscription lifecycle, history tracking, and access control.
 * 
 * Primary responsibilities:
 * - Managing TPA data subscriptions
 * - Tracking subscription history
 * - Validating subscription access
 * - Providing subscription queries for broadcasting
 * - Enforcing permission checks on subscriptions
 */

import { StreamType, ExtendedStreamType, isLanguageStream, UserSession, parseLanguageStream, createTranscriptionStream, CalendarEvent } from '@augmentos/sdk';
import { logger } from '@augmentos/utils';
import { SimplePermissionChecker } from '../permissions/simple-permission-checker';
import App from '../../models/app.model';
import { sessionService } from './session.service';

/**
 * Record of a subscription change
 */
interface SubscriptionHistory {
  timestamp: Date;
  subscriptions: ExtendedStreamType[];
  action: 'add' | 'remove' | 'update';
}

/**
 * Location data structure
 */
interface Location {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: Date;
}

/**
 * Implementation of the subscription management service.
 * Design decisions:
 * 1. In-memory storage for fast access
 * 2. History tracking for debugging
 * 3. Wildcard subscription support ('*' or 'all')
 * 4. Session-scoped subscriptions
 */
export class SubscriptionService {
  /**
   * Map of active subscriptions keyed by session:app
   * @private
   */
  private subscriptions = new Map<string, Set<ExtendedStreamType>>();

  /**
   * Map of subscription history keyed by session:app
   * @private
   */
  private history = new Map<string, SubscriptionHistory[]>();

  /**
   * Cache for all calendar events per session
   * @private
   */
  private calendarEventsCache = new Map<string, CalendarEvent[]>();

  /**
   * Cache for the last location per session
   * @private
   */
  private lastLocationCache = new Map<string, Location>();

  /**
   * Caches a calendar event for a session (appends to the list)
   * @param sessionId - User session identifier
   * @param event - Calendar event to cache
   */
  cacheCalendarEvent(sessionId: string, event: CalendarEvent): void {
    if (!this.calendarEventsCache.has(sessionId)) {
      this.calendarEventsCache.set(sessionId, []);
    }
    this.calendarEventsCache.get(sessionId)!.push(event);
    logger.info(`Cached calendar event for session ${sessionId} (total: ${this.calendarEventsCache.get(sessionId)!.length})`);
  }

  /**
   * Gets all cached calendar events for a session
   * @param sessionId - User session identifier
   * @returns Array of calendar events (empty if none)
   */
  getAllCalendarEvents(sessionId: string): CalendarEvent[] {
    return this.calendarEventsCache.get(sessionId) || [];
  }

  /**
   * Removes all cached calendar events for a session
   * @param sessionId - User session identifier
   */
  clearCalendarEvents(sessionId: string): void {
    this.calendarEventsCache.delete(sessionId);
    logger.info(`Cleared all calendar events for session ${sessionId}`);
  }

  /**
   * @deprecated Use getAllCalendarEvents instead
   */
  getLastCalendarEvent(sessionId: string): CalendarEvent | undefined {
    const events = this.calendarEventsCache.get(sessionId);
    return events && events.length > 0 ? events[events.length - 1] : undefined;
  }

  /**
   * Caches the last location for a session
   * @param sessionId - User session identifier
   * @param location - Location to cache
   */
  cacheLocation(sessionId: string, location: Location): void {
    this.lastLocationCache.set(sessionId, location);
    logger.info(`Cached location for session ${sessionId}`);
  }

  /**
   * Gets the last cached location for a session
   * @param sessionId - User session identifier
   * @returns The last location or undefined if none exists
   */
  getLastLocation(sessionId: string): Location | undefined {
    return this.lastLocationCache.get(sessionId);
  }

  /**
   * Generates a unique key for subscription storage
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   * @returns Unique key for the session-app pair
   * @private
   */
  private getKey(sessionId: string, packageName: string): string {
    return `${sessionId}:${packageName}`;
  }

  /**
   * Caches the subscription update version for each session-app
   * @private
   */
  private subscriptionUpdateVersion = new Map<string, number>();

  /**
   * Updates subscriptions for a TPA.
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   * @param userId - User identifier for validation
   * @param subscriptions - New set of subscriptions
   * @throws If invalid subscription types are requested or permissions are missing
   */
  async updateSubscriptions(
    sessionId: string,
    packageName: string,
    userId: string,
    subscriptions: ExtendedStreamType[]
  ): Promise<void> {
    const key = this.getKey(sessionId, packageName);

    // Increment version for this key
    const currentVersion = (this.subscriptionUpdateVersion.get(key) || 0) + 1;
    this.subscriptionUpdateVersion.set(key, currentVersion);

    // Capture the version for this call
    const thisCallVersion = currentVersion;

    logger.info(`[SubscriptionService] updateSubscriptions called for ${key}. Subscriptions received:`, subscriptions);
    const currentSubs = this.subscriptions.get(key) || new Set();
    const action: SubscriptionHistory['action'] = currentSubs.size === 0 ? 'add' : 'update';

    logger.info(`🎤 Updating subscriptions for ${key} with ${subscriptions}`);

    // Validate subscriptions format
    const processedSubscriptions = subscriptions.map(sub =>
      sub === StreamType.TRANSCRIPTION ?
        createTranscriptionStream('en-US') :
        sub
    );

    for (const sub of processedSubscriptions) {
      if (!this.isValidSubscription(sub)) {
        throw new Error(`Invalid subscription type: ${sub}`);
      }
    }

    logger.info("[SubscriptionService] Processed subscriptions:", processedSubscriptions);

    try {
      // Get app details
      const app = await App.findOne({ packageName });
      
      if (!app) {
        logger.warn(`App ${packageName} not found when checking permissions`);
        throw new Error(`App ${packageName} not found`);
      }

      // Filter subscriptions based on permissions
      const { allowed, rejected } = SimplePermissionChecker.filterSubscriptions(app, processedSubscriptions);

      logger.info(`[SubscriptionService] Subscriptions map after update:`, Array.from(this.subscriptions.entries()).map(([k, v]) => [k, Array.from(v)]));

      logger.info(`Updated subscriptions for ${packageName} in session ${sessionId}:`, processedSubscriptions);

      // If some subscriptions were rejected, send an error message to the client
      if (rejected.length > 0) {
        logger.warn(
          `Rejected ${rejected.length} subscription(s) for ${packageName} due to missing permissions: ` +
          rejected.map(r => `${r.stream} (requires ${r.requiredPermission})`).join(', ')
        );
        
        // Find the user session to get the app connection
        const userSession = sessionService.getSession(sessionId);
        
        if (userSession && userSession.appConnections) {
          const connection = userSession.appConnections.get(packageName);
          
          if (connection && connection.readyState === 1) {
            // Send a detailed error message to the TPA about the rejected subscriptions
            const errorMessage = {
              type: 'permission_error',
              message: 'Some subscriptions were rejected due to missing permissions',
              details: rejected.map(r => ({
                stream: r.stream,
                requiredPermission: r.requiredPermission,
                message: `To subscribe to ${r.stream}, add the ${r.requiredPermission} permission in the developer console`
              })),
              timestamp: new Date()
            };
            
            connection.send(JSON.stringify(errorMessage));
          }
        }
        
        // Continue with only the allowed subscriptions
        processedSubscriptions.length = 0;
        processedSubscriptions.push(...allowed);
      }
      const newSubs = new Set(processedSubscriptions);

      // At the end, before setting:
      if (this.subscriptionUpdateVersion.get(key) !== thisCallVersion) {
        // A newer call has started, so abort this update
        logger.info("🔥🔥🔥: Skipping update as newer call has started");
        return;
      }

      // Only now set the subscriptions
      this.subscriptions.set(key, newSubs);

      // Record history
      this.addToHistory(key, {
        timestamp: new Date(),
        subscriptions: [...processedSubscriptions],
        action
      });

      logger.info(`Updated subscriptions for ${packageName} in session ${sessionId}:`, processedSubscriptions);
    } catch (error) {
      // If there's an error getting the app or checking permissions, log it but don't block
      // This ensures backward compatibility with existing code
      logger.error(`Error checking permissions for ${packageName}:`, error);
      
      // Continue with the subscription update
      this.subscriptions.set(key, new Set(processedSubscriptions));
      
      // Record history
      this.addToHistory(key, {
        timestamp: new Date(),
        subscriptions: [...processedSubscriptions],
        action
      });
    }
  }

  /**
   * Returns an object listing which TPAs (by package name) for a specific user (session)
   * are subscribed to "audio_chunk", "translation", and "transcription".
   */
  hasMediaSubscriptions(sessionId: string): boolean {
    // console.log("🔥🔥🔥: hasMediaSubscriptions:", sessionId);
    // console.log("🔥🔥🔥: this.subscriptions:", this.subscriptions.entries());

    for (const [key, subs] of this.subscriptions.entries()) {
      // Only consider subscriptions for the given user session.
      if (!key.startsWith(sessionId + ':')) continue;

      for (const sub of subs) {
        // Check plain stream types.
        if (
          sub === StreamType.AUDIO_CHUNK ||
          sub === StreamType.TRANSLATION ||
          sub === StreamType.TRANSCRIPTION
        ) {
          return true;
        }
        // Check if it's a language-specific subscription.
        const langInfo = parseLanguageStream(sub as string);
        if (langInfo && (langInfo.type === StreamType.TRANSLATION || langInfo.type === StreamType.TRANSCRIPTION)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Gets all TPAs subscribed to a specific stream type
   * @param session - User session identifier
   * @param subscription - Subscription type to check
   * @returns Array of app IDs subscribed to the stream
   */
  getSubscribedApps(userSession: UserSession, subscription: ExtendedStreamType): string[] {
    const sessionId = userSession.sessionId;
    const subscribedApps: string[] = [];
    // console.log("🎤 1111 Subscribed apps: ", this.subscriptions.entries());

    for (const [key, subs] of this.subscriptions.entries()) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      const [, packageName] = key.split(':');
      for (const sub of subs) {
        // If it's a plain subscription or wildcard
        if (
          sub === subscription ||
          sub === StreamType.ALL ||
          sub === StreamType.WILDCARD
        ) {
          subscribedApps.push(packageName);
          break;
        }
      }
    }
    return subscribedApps;
  }

  /**
   * Gets all active subscriptions for a TPA
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   * @returns Array of active subscriptions
   */
  getAppSubscriptions(sessionId: string, packageName: string): ExtendedStreamType[] {
    const key = this.getKey(sessionId, packageName);
    const subs = this.subscriptions.get(key);
    return subs ? Array.from(subs) : [];
  }

  /**
   * Gets subscription history for a TPA
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   * @returns Array of historical subscription changes
   */
  getSubscriptionHistory(sessionId: string, packageName: string): SubscriptionHistory[] {
    const key = this.getKey(sessionId, packageName);
    return this.history.get(key) || [];
  }

  /**
   * Removes all subscriptions for a TPA
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   */
  removeSubscriptions(userSession: UserSession, packageName: string): void {
    const key = this.getKey(userSession.sessionId, packageName);
    // if (userSession.appConnections.has(packageName)) {
    //   // TODO send message to user that we are destroying the connection.
    //   userSession.appConnections.delete(packageName);
    // }

    if (this.subscriptions.has(key)) {
      const currentSubs = Array.from(this.subscriptions.get(key) || []);

      this.subscriptions.delete(key);
      this.addToHistory(key, {
        timestamp: new Date(),
        subscriptions: currentSubs,
        action: 'remove'
      });

      logger.info(`Removed all subscriptions for ${packageName} in session ${userSession.sessionId}`);
    }
  }

  /**
   * Removes all subscription history for a session
   * Used when a session is being killed to free memory
   * @param sessionId - User session identifier
   */
  removeSessionSubscriptionHistory(sessionId: string): void {
    // Find all keys that start with this session ID
    const keysToRemove: string[] = [];

    for (const key of this.history.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        keysToRemove.push(key);
      }
    }

    // Remove all history entries for this session
    keysToRemove.forEach(key => {
      this.history.delete(key);
    });

    // Remove cached calendar events for this session
    this.calendarEventsCache.delete(sessionId);
    
    // Remove cached location for this session
    this.lastLocationCache.delete(sessionId);

    logger.info(`Removed subscription history for session ${sessionId} (${keysToRemove.length} entries)`);
  }

  /**
   * Checks if a TPA has a specific subscription
   * @param sessionId - User session identifier
   * @param packageName - TPA identifier
   * @param subscription - Subscription type to check
   * @returns Boolean indicating if the subscription exists
   */
  hasSubscription(
    sessionId: string,
    packageName: string,
    subscription: StreamType
  ): boolean {
    const key = this.getKey(sessionId, packageName);
    const subs = this.subscriptions.get(key);

    if (!subs) return false;
    return subs.has(subscription) || subs.has(StreamType.WILDCARD) || subs.has(StreamType.ALL);
  }

  /**
   * Adds an entry to the subscription history
   * @param key - Session:app key
   * @param entry - History entry to add
   * @private
   */
  private addToHistory(key: string, entry: SubscriptionHistory): void {
    const history = this.history.get(key) || [];
    history.push(entry);
    this.history.set(key, history);
  }

  /**
   * Returns the minimal set of language-specific subscriptions for a given user session.
   * For example, if a user's apps request:
   *  - transcription:en-US
   *  - translation:es-ES-to-en-US
   *  - transcription:en-US
   *
   * This function returns:
   * [ "transcription:en-US", "translation:es-ES-to-en-US" ]
   */
  getMinimalLanguageSubscriptions(sessionId: string): ExtendedStreamType[] {
    const languageSet = new Set<ExtendedStreamType>();
    for (const [key, subs] of this.subscriptions.entries()) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      for (const sub of subs) {
        if (isLanguageStream(sub)) {
          languageSet.add(sub);
        }
      }
    }
    return Array.from(languageSet);
  }

  /**
   * Gets all TPAs subscribed to a specific AugmentOS setting key
   * @param userSession - User session identifier
   * @param settingKey - The augmentosSettings key (e.g., 'metricSystemEnabled')
   * @returns Array of app IDs subscribed to the augmentos setting
   */
  getSubscribedAppsForAugmentosSetting(userSession: UserSession, settingKey: string): string[] {
    const sessionId = userSession.sessionId;
    const subscribedApps: string[] = [];
    const subscription = `augmentos:${settingKey}`;

    logger.info(`[SubscriptionService] getSubscribedAppsForAugmentosSetting called for session ${sessionId}, key '${settingKey}'. Current subscriptions map:`, Array.from(this.subscriptions.entries()).map(([k, v]) => [k, Array.from(v)]));
    for (const [key, subs] of this.subscriptions.entries()) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      const [, packageName] = key.split(':');
      for (const sub of subs) {
        if (sub === subscription || sub === 'augmentos:*' || sub === 'augmentos:all') {
          logger.info(`[SubscriptionService] App '${packageName}' is subscribed to '${subscription}' (or wildcard) in session ${sessionId}.`);
          subscribedApps.push(packageName);
          break;
        }
      }
    }
    logger.info(`[SubscriptionService] Subscribed apps for AugmentOS setting '${settingKey}' in session ${sessionId}:`, subscribedApps);
    return subscribedApps;
  }

  /**
   * Validates a subscription type
   * @param subscription - Subscription to validate
   * @returns Boolean indicating if the subscription is valid
   * @private
   */
  private isValidSubscription(subscription: ExtendedStreamType): boolean {
    const validTypes = new Set(Object.values(StreamType));
    // Allow augmentos:<key> subscriptions for AugmentOS settings
    if (typeof subscription === 'string' && subscription.startsWith('augmentos:')) {
      return true;
    }
    return validTypes.has(subscription as StreamType) || isLanguageStream(subscription);
  }

  public getSubscriptionEntries() {
    return Array.from(this.subscriptions.entries()).map(([k, v]) => [k, Array.from(v)]);
  }
}

// Create singleton instance
export const subscriptionService = new SubscriptionService();
logger.info('✅ Subscription Service');

export default subscriptionService;