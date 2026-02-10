import { Logger } from "pino";

import {
  StreamType,
  ExtendedStreamType,
  isLanguageStream,
  parseLanguageStream,
  createTranscriptionStream,
  SubscriptionRequest,
} from "@mentra/sdk";


import App from "../../models/app.model";
import { SimplePermissionChecker } from "../permissions/simple-permission-checker";

import { AppSession, LocationRate } from "./AppSession";
import UserSession from "./UserSession";

/**
 * SubscriptionManager coordinates subscriptions across all apps in a user session.
 *
 * Architecture (Simplified):
 * - Per-app subscriptions: Stored in AppSession._subscriptions (single source of truth)
 * - Per-app location rate: Stored in AppSession._locationRate
 * - Cross-app queries: Computed on demand from AppSessions (no caches!)
 *
 * This manager:
 * 1. Validates and processes incoming subscription requests
 * 2. Delegates per-app storage to AppSession
 * 3. Provides query methods that aggregate across AppSessions
 * 4. Coordinates with other managers (Transcription, Translation, Location, Calendar)
 *
 * Design Decisions:
 * - No cached aggregates (appsWithPCM, appsWithTranscription, languageStreamCounts removed)
 *   - Caches could drift from AppSession state
 *   - Typical session has 1-5 apps, iteration is cheap
 *   - Single source of truth eliminates bugs
 * - No per-app update serialization (updateChainsByApp removed)
 *   - Only protected same-app races, not cross-app
 *   - Most subscription operations are synchronous now
 *   - Downstream managers should handle their own concurrency if needed
 */
export class SubscriptionManager {
  private readonly userSession: UserSession;
  private readonly logger: Logger;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "SubscriptionManager" });
    this.logger.info({ userId: userSession.userId }, "SubscriptionManager initialized");
  }

  // ===== Public API =====

  /**
   * Get subscriptions for a specific app (delegates to AppSession)
   */
  getAppSubscriptions(packageName: string): ExtendedStreamType[] {
    const appSession = this.userSession.appManager.getAppSession(packageName);
    return appSession?.getSubscriptions() ?? [];
  }

  /**
   * Check if an app has a specific subscription (delegates to AppSession)
   */
  hasSubscription(packageName: string, subscription: StreamType): boolean {
    const appSession = this.userSession.appManager.getAppSession(packageName);
    if (!appSession) return false;
    return appSession.hasSubscription(subscription);
  }

  /**
   * Get all apps subscribed to a specific stream type
   * Computed on demand from AppSessions
   */
  getSubscribedApps(subscription: ExtendedStreamType): string[] {
    const subscribedApps: string[] = [];

    // Parse the incoming subscription to get base type and language
    const incomingParsed = isLanguageStream(subscription as string)
      ? parseLanguageStream(subscription as string)
      : null;

    for (const [packageName, appSession] of this.getAppSessionEntries()) {
      const subs = appSession.subscriptions;
      for (const sub of subs) {
        if (sub === subscription || sub === StreamType.ALL || sub === StreamType.WILDCARD) {
          subscribedApps.push(packageName);
          break;
        }

        // For language streams, compare base type and language (ignore query params like ?hints=)
        if (incomingParsed && isLanguageStream(sub as string)) {
          const subParsed = parseLanguageStream(sub as string);
          if (
            subParsed &&
            subParsed.type === incomingParsed.type &&
            subParsed.transcribeLanguage === incomingParsed.transcribeLanguage
          ) {
            subscribedApps.push(packageName);
            break;
          }
        }

        // Back-compat: location_stream implies location_update
        if (subscription === StreamType.LOCATION_UPDATE && sub === StreamType.LOCATION_STREAM) {
          subscribedApps.push(packageName);
          break;
        }
      }
    }
    return subscribedApps;
  }

  /**
   * Get all apps subscribed to a specific AugmentOS setting
   */
  getSubscribedAppsForAugmentosSetting(settingKey: string): string[] {
    const subscribed: string[] = [];
    const target = `augmentos:${settingKey}`;

    for (const [packageName, appSession] of this.getAppSessionEntries()) {
      const subs = appSession.subscriptions;
      for (const sub of subs) {
        if (sub === target || sub === ("augmentos:*" as any) || sub === ("augmentos:all" as any)) {
          subscribed.push(packageName);
          break;
        }
      }
    }
    return subscribed;
  }

  /**
   * Get unique language subscriptions across all apps
   * Computed on demand from AppSessions
   */
  getMinimalLanguageSubscriptions(): ExtendedStreamType[] {
    const languageSet = new Set<ExtendedStreamType>();

    for (const [, appSession] of this.getAppSessionEntries()) {
      for (const sub of appSession.subscriptions) {
        if (isLanguageStream(sub as string)) {
          languageSet.add(sub);
        }
      }
    }

    return Array.from(languageSet);
  }

  /**
   * Check if any app needs PCM audio or transcription
   * Computed on demand from AppSessions
   */
  hasPCMTranscriptionSubscriptions(): {
    hasMedia: boolean;
    hasPCM: boolean;
    hasTranscription: boolean;
  } {
    let hasPCM = false;
    let hasTranscription = false;

    for (const [, appSession] of this.getAppSessionEntries()) {
      for (const sub of appSession.subscriptions) {
        // Check for PCM (raw audio)
        if (sub === StreamType.AUDIO_CHUNK) {
          hasPCM = true;
        }

        // Check for transcription-like streams
        if (this.isTranscriptionLike(sub)) {
          hasTranscription = true;
        }

        // Early exit if we found both
        if (hasPCM && hasTranscription) {
          break;
        }
      }

      if (hasPCM && hasTranscription) {
        break;
      }
    }

    const hasMedia = hasPCM || hasTranscription;
    return { hasMedia, hasPCM, hasTranscription };
  }

  /**
   * Update subscriptions for an app
   * Validates permissions, then delegates storage to AppSession
   *
   * Uses AppSession.enqueue() to serialize updates per-app, preventing race
   * conditions when multiple subscription updates arrive rapidly. See Issue 008.
   */
  async updateSubscriptions(packageName: string, subscriptions: SubscriptionRequest[]): Promise<void> {
    // Get or create AppSession for this app
    const appSession = this.userSession.appManager.getOrCreateAppSession(packageName);

    // If AppManager is disposed, we can't update subscriptions
    if (!appSession) {
      this.logger.warn({ packageName }, "Cannot update subscriptions - AppManager disposed");
      return;
    }

    // Serialize subscription updates per-app to prevent race conditions.
    // Multiple updates can arrive rapidly during startup and would otherwise
    // process concurrently, causing the wrong final state. See Issue 008.
    await appSession.enqueue(async () => {
      await this.processSubscriptionUpdate(appSession, packageName, subscriptions);
    });
  }

  /**
   * Internal implementation of subscription update processing.
   * Called from the serialized queue to ensure updates are processed in order.
   */
  private async processSubscriptionUpdate(
    appSession: AppSession,
    packageName: string,
    subscriptions: SubscriptionRequest[],
  ): Promise<void> {
    // Process incoming subscriptions array (strings and special location objects)
    const streamSubscriptions: ExtendedStreamType[] = [];
    let locationRate: LocationRate | null = null;

    for (const sub of subscriptions) {
      if (
        typeof sub === "object" &&
        sub !== null &&
        "stream" in sub &&
        (sub as any).stream === StreamType.LOCATION_STREAM
      ) {
        locationRate = (sub as any).rate || null;
        streamSubscriptions.push(StreamType.LOCATION_STREAM);
      } else if (typeof sub === "string") {
        streamSubscriptions.push(sub as ExtendedStreamType);
      }
    }

    // Convert bare TRANSCRIPTION to language-specific stream
    const processed: ExtendedStreamType[] = streamSubscriptions.map((sub) =>
      sub === StreamType.TRANSCRIPTION ? createTranscriptionStream("en-US") : sub,
    );

    // Validate permissions (best-effort)
    let allowedProcessed: ExtendedStreamType[] = processed;
    try {
      const app = await App.findOne({ packageName });
      if (app) {
        const { allowed, rejected } = SimplePermissionChecker.filterSubscriptions(app, processed);
        if (rejected.length > 0) {
          this.logger.warn(
            {
              userId: this.userSession.userId,
              packageName,
              rejectedCount: rejected.length,
              rejected,
            },
            "Rejected subscriptions due to missing permissions",
          );
        }
        allowedProcessed = allowed;
      }
    } catch (error) {
      this.logger.error({ packageName, error }, "Error validating subscriptions; continuing with all requested");
    }

    // Delegate to AppSession for storage and grace period handling
    const updateResult = appSession.updateSubscriptions(allowedProcessed, locationRate);

    if (!updateResult.applied) {
      this.logger.info(
        {
          userId: this.userSession.userId,
          packageName,
          reason: updateResult.reason,
        },
        "Subscription update not applied by AppSession",
      );
      return;
    }

    this.logger.info(
      {
        userId: this.userSession.userId,
        packageName,
        subscriptions: allowedProcessed,
        locationRate,
      },
      "Updated subscriptions via AppSession",
    );

    // Sync downstream managers
    await this.syncManagers();
    this.userSession.microphoneManager?.handleSubscriptionChange();
  }

  /**
   * Remove all subscriptions for an app (delegates to AppSession)
   */
  async removeSubscriptions(packageName: string): Promise<void> {
    const appSession = this.userSession.appManager.getAppSession(packageName);
    if (appSession && appSession.subscriptions.size > 0) {
      appSession.clearSubscriptions();
      this.logger.info({ userId: this.userSession.userId, packageName }, "Removed subscriptions for app");
    }

    // Notify managers about unsubscribe
    this.userSession.locationManager.handleUnsubscribe(packageName);
    this.userSession.calendarManager.handleUnsubscribe(packageName);

    await this.syncManagers();
    this.userSession.microphoneManager?.handleSubscriptionChange();
  }

  /**
   * Get subscription history for an app (delegates to AppSession)
   */
  getHistory(packageName: string) {
    const appSession = this.userSession.appManager.getAppSession(packageName);
    return appSession?.getSubscriptionHistory() ?? [];
  }

  /**
   * Clean up SubscriptionManager state
   */
  dispose(): void {
    this.logger.debug("SubscriptionManager disposed");
  }

  // ===== Private helpers =====

  /**
   * Get all AppSession entries from AppManager
   */
  private getAppSessionEntries(): [string, AppSession][] {
    const appSessions = this.userSession.appManager.getAllAppSessions();
    return Array.from(appSessions.entries());
  }

  /**
   * Check if a subscription is transcription-like (transcription or translation)
   */
  private isTranscriptionLike(sub: ExtendedStreamType): boolean {
    if (sub === StreamType.TRANSCRIPTION || sub === StreamType.TRANSLATION) {
      return true;
    }

    if (isLanguageStream(sub as string)) {
      const info = parseLanguageStream(sub as string);
      if (info && (info.type === StreamType.TRANSCRIPTION || info.type === StreamType.TRANSLATION)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Extract location subscriptions from all apps
   * Returns data for LocationManager to compute effective tier
   */
  private getLocationSubscriptions(): Array<{
    packageName: string;
    rate: string;
  }> {
    const result: Array<{ packageName: string; rate: string }> = [];

    for (const [packageName, appSession] of this.getAppSessionEntries()) {
      if (appSession.subscriptions.has(StreamType.LOCATION_STREAM)) {
        const rate = appSession.locationRate;
        if (rate) {
          result.push({ packageName, rate });
        }
      }
    }

    return result;
  }

  /**
   * Extract calendar subscriptions from all apps
   */
  private getCalendarSubscriptions(): string[] {
    const result: string[] = [];

    for (const [packageName, appSession] of this.getAppSessionEntries()) {
      if (appSession.subscriptions.has(StreamType.CALENDAR_EVENT)) {
        result.push(packageName);
      }
    }

    return result;
  }

  /**
   * Get all transcription subscriptions across all apps
   */
  private getTranscriptionSubscriptions(): ExtendedStreamType[] {
    const subs: ExtendedStreamType[] = [];

    for (const [, appSession] of this.getAppSessionEntries()) {
      for (const sub of appSession.subscriptions) {
        if (typeof sub === "string" && sub.includes("transcription") && !sub.includes("translation")) {
          subs.push(sub);
        }
      }
    }

    return subs;
  }

  /**
   * Get all translation subscriptions across all apps
   */
  private getTranslationSubscriptions(): ExtendedStreamType[] {
    const subs: ExtendedStreamType[] = [];

    for (const [, appSession] of this.getAppSessionEntries()) {
      for (const sub of appSession.subscriptions) {
        if (typeof sub === "string" && sub.includes("translation")) {
          subs.push(sub);
        }
      }
    }

    return subs;
  }

  /**
   * Sync all downstream managers with current subscription state
   */
  private async syncManagers(): Promise<void> {
    try {
      // Sync transcription
      const transcriptionSubs = this.getTranscriptionSubscriptions();
      await this.userSession.transcriptionManager.updateSubscriptions(transcriptionSubs);

      // Sync translation
      const translationSubs = this.getTranslationSubscriptions();
      await this.userSession.translationManager.updateSubscriptions(translationSubs);

      // Ensure streams exist
      await Promise.all([
        this.userSession.transcriptionManager.ensureStreamsExist(),
        this.userSession.translationManager.ensureStreamsExist(),
      ]);

      // Sync location
      const locationSubs = this.getLocationSubscriptions();
      this.userSession.locationManager.handleSubscriptionUpdate(locationSubs);

      // Sync calendar
      const calendarSubs = this.getCalendarSubscriptions();
      this.userSession.calendarManager.handleSubscriptionUpdate(calendarSubs);
    } catch (error) {
      this.logger.error({ userId: this.userSession.userId, error }, "Error syncing managers with subscriptions");
    }
  }
}

export default SubscriptionManager;
