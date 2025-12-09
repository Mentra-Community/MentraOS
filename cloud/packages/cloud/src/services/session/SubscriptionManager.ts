import {
  StreamType,
  ExtendedStreamType,
  isLanguageStream,
  parseLanguageStream,
  createTranscriptionStream,
  SubscriptionRequest,
} from "@mentra/sdk";
import { Logger } from "pino";
import UserSession from "./UserSession";
import App from "../../models/app.model";
import { SimplePermissionChecker } from "../permissions/simple-permission-checker";
import { User, UserI } from "../../models/user.model";
import { MongoSanitizer } from "../../utils/mongoSanitizer";

export class SubscriptionManager {
  private readonly userSession: UserSession;
  private readonly logger: Logger;

  // Map of packageName -> Set of subscriptions
  private subscriptions: Map<string, Set<ExtendedStreamType>> = new Map();

  // History per app for debugging/restore
  private history: Map<
    string,
    {
      timestamp: Date;
      subscriptions: ExtendedStreamType[];
      action: "add" | "remove" | "update";
    }[]
  > = new Map();

  // Track app reconnect timestamps for empty-subscription grace handling
  private lastAppReconnectAt: Map<string, number> = new Map();
  private readonly CONNECT_GRACE_MS = 8000; // 8 seconds for slower reconnects

  // Per-app update serialization (mutex/queue)
  private updateChainsByApp: Map<string, Promise<unknown>> = new Map();

  // Cached aggregates for O(1) reads - track which apps need what
  private appsWithPCM = new Set<string>(); // packageNames that need PCM
  private appsWithTranscription = new Set<string>(); // packageNames that need transcription/translation
  private languageStreamCounts: Map<ExtendedStreamType, number> = new Map();

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "SubscriptionManager" });
    this.logger.info(
      { userId: userSession.userId },
      "SubscriptionManager initialized",
    );
  }

  // ===== Public API =====

  markAppReconnected(packageName: string): void {
    this.lastAppReconnectAt.set(packageName, Date.now());
  }

  getAppSubscriptions(packageName: string): ExtendedStreamType[] {
    const subs = this.subscriptions.get(packageName);
    const result = subs ? Array.from(subs) : [];
    this.logger.debug(
      { userId: this.userSession.userId, packageName, subscriptions: result },
      "Retrieved app subscriptions",
    );
    return result;
  }

  hasSubscription(packageName: string, subscription: StreamType): boolean {
    const subs = this.subscriptions.get(packageName);
    if (!subs) return false;
    return (
      subs.has(subscription) ||
      subs.has(StreamType.WILDCARD) ||
      subs.has(StreamType.ALL)
    );
  }

  getSubscribedApps(subscription: ExtendedStreamType): string[] {
    const subscribedApps: string[] = [];

    // Parse the incoming subscription to get base type and language
    const incomingParsed = isLanguageStream(subscription as string)
      ? parseLanguageStream(subscription as string)
      : null;

    for (const [packageName, subs] of this.subscriptions.entries()) {
      for (const sub of subs) {
        if (
          sub === subscription ||
          sub === StreamType.ALL ||
          sub === StreamType.WILDCARD
        ) {
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
        if (
          subscription === StreamType.LOCATION_UPDATE &&
          sub === StreamType.LOCATION_STREAM
        ) {
          subscribedApps.push(packageName);
          break;
        }
      }
    }
    return subscribedApps;
  }

  getSubscribedAppsForAugmentosSetting(settingKey: string): string[] {
    const subscribed: string[] = [];
    const target = `augmentos:${settingKey}`;
    for (const [packageName, subs] of this.subscriptions.entries()) {
      for (const sub of subs) {
        if (
          sub === target ||
          sub === ("augmentos:*" as any) ||
          sub === ("augmentos:all" as any)
        ) {
          subscribed.push(packageName);
          break;
        }
      }
    }
    this.logger.info(
      { userId: this.userSession.userId, settingKey, subscribed },
      "AugmentOS setting subscription results",
    );
    return subscribed;
  }

  getMinimalLanguageSubscriptions(): ExtendedStreamType[] {
    const result: ExtendedStreamType[] = [];
    for (const [langStream, count] of this.languageStreamCounts.entries()) {
      if (count > 0) result.push(langStream);
    }
    return result;
  }

  hasPCMTranscriptionSubscriptions(): {
    hasMedia: boolean;
    hasPCM: boolean;
    hasTranscription: boolean;
  } {
    const hasPCM = this.appsWithPCM.size > 0;
    const hasTranscription = this.appsWithTranscription.size > 0;
    const hasMedia = hasPCM || hasTranscription;

    this.logger.debug(
      {
        appsWithPCM: Array.from(this.appsWithPCM),
        appsWithTranscription: Array.from(this.appsWithTranscription),
        hasPCM,
        hasTranscription,
        hasMedia,
      },
      "hasPCMTranscriptionSubscriptions called",
    );

    return { hasMedia, hasPCM, hasTranscription };
  }

  async updateSubscriptions(
    packageName: string,
    subscriptions: SubscriptionRequest[],
  ): Promise<UserI | null> {
    // Serialize per-app updates via promise chaining
    const previous =
      this.updateChainsByApp.get(packageName) || Promise.resolve();
    let resultUser: UserI | null = null;

    const chained = previous.then(async () => {
      const now = Date.now();
      const lastReconnect = this.lastAppReconnectAt.get(packageName) || 0;

      // Process incoming subscriptions array (strings and special location objects)
      const streamSubscriptions: ExtendedStreamType[] = [];
      let locationRate: string | null = null;
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

      const processed: ExtendedStreamType[] = streamSubscriptions.map((sub) =>
        sub === StreamType.TRANSCRIPTION
          ? createTranscriptionStream("en-US")
          : sub,
      );

      // Reconnect grace: ignore empty subs right after reconnect
      if (
        processed.length === 0 &&
        now - lastReconnect <= this.CONNECT_GRACE_MS
      ) {
        this.logger.warn(
          { userId: this.userSession.userId, packageName },
          "Ignoring empty subscription update within reconnect grace window",
        );
        resultUser = await this.persistLocationRate(packageName, locationRate);
        return; // Skip applying empty update
      }

      // Validate permissions (best-effort)
      let allowedProcessed: ExtendedStreamType[] = processed;
      try {
        const app = await App.findOne({ packageName });
        if (app) {
          const { allowed, rejected } =
            SimplePermissionChecker.filterSubscriptions(app, processed);
          if (rejected.length > 0) {
            this.logger.warn(
              {
                userId: this.userSession.userId,
                packageName,
                rejectedCount: rejected.length,
              },
              "Rejected subscriptions due to missing permissions",
            );
          }
          allowedProcessed = allowed;
        }
      } catch (error) {
        const logger = this.logger.child({ packageName });
        logger.error(error, "Error validating subscriptions; continuing");
      }

      // Compute delta and update maps atomically
      const oldSet =
        this.subscriptions.get(packageName) || new Set<ExtendedStreamType>();
      const newSet = new Set<ExtendedStreamType>(allowedProcessed);
      this.applyDelta(packageName, oldSet, newSet);
      this.subscriptions.set(packageName, newSet);
      this.addHistory(packageName, {
        timestamp: new Date(),
        subscriptions: [...newSet],
        action: "update",
      });

      this.logger.info(
        {
          userId: this.userSession.userId,
          packageName,
          processedSubscriptions: [...newSet],
        },
        "Updated subscriptions successfully",
      );

      // Sync managers and mic
      await this.syncManagers();
      this.userSession.microphoneManager?.handleSubscriptionChange();

      // Persist location rate setting for this app
      resultUser = await this.persistLocationRate(packageName, locationRate);
    });

    // Store chain and return when this link finishes
    this.updateChainsByApp.set(
      packageName,
      chained.catch((error) => {
        const _logger = this.logger.child({ packageName });
        _logger.error(error, "Error in subscription update chain");
      }),
    );
    await chained;
    return resultUser;
  }

  async removeSubscriptions(packageName: string): Promise<UserI | null> {
    const existing = this.subscriptions.get(packageName);
    if (existing) {
      this.addHistory(packageName, {
        timestamp: new Date(),
        subscriptions: Array.from(existing),
        action: "remove",
      });
      // apply delta to aggregates and clear
      this.applyDelta(packageName, existing, new Set<ExtendedStreamType>());
      this.subscriptions.delete(packageName);
      this.logger.info(
        { userId: this.userSession.userId, packageName },
        "Removed in-memory subscriptions for app",
      );
    }

    // Notify managers about unsubscribe
    this.userSession.locationManager.handleUnsubscribe(packageName);
    this.userSession.calendarManager.handleUnsubscribe(packageName);

    await this.syncManagers();
    this.userSession.microphoneManager?.handleSubscriptionChange();

    // Clear location rate for this app in DB
    try {
      const user = await User.findOne({ email: this.userSession.userId });
      if (user) {
        const sanitizedPackage = MongoSanitizer.sanitizeKey(packageName);
        if (user.locationSubscriptions?.has(sanitizedPackage)) {
          user.locationSubscriptions.delete(sanitizedPackage);
          user.markModified("locationSubscriptions");
          await user.save();
        }
        return user;
      }
    } catch (error) {
      const logger = this.logger.child({ packageName });
      logger.error(error, "Error removing location subscription from DB");
    }
    return null;
  }

  getHistory(packageName: string) {
    return this.history.get(packageName) || [];
  }

  dispose(): void {
    this.subscriptions.clear();
    this.history.clear();

    this.lastAppReconnectAt.clear();
  }

  // ===== Private helpers =====

  private addHistory(
    packageName: string,
    entry: {
      timestamp: Date;
      subscriptions: ExtendedStreamType[];
      action: "add" | "remove" | "update";
    },
  ): void {
    const list = this.history.get(packageName) || [];
    list.push(entry);
    this.history.set(packageName, list);
  }

  /**
   * Deprecated: No longer persist location subscriptions to DB
   * Location subscriptions are now tracked in-memory only
   */
  private async persistLocationRate(
    _packageName: string,
    _locationRate: string | null,
  ): Promise<UserI | null> {
    // No-op: location subscriptions are now in-memory only
    // This method is kept for backward compatibility during migration
    return null;
  }

  /**
   * Extract location subscriptions from all app subscriptions.
   * Returns lightweight data for LocationManager to process.
   */
  private getLocationSubscriptions(): Array<{
    packageName: string;
    rate: string;
  }> {
    const result: Array<{ packageName: string; rate: string }> = [];

    for (const [packageName, subs] of this.subscriptions.entries()) {
      for (const sub of subs) {
        // Check for location_stream subscription objects
        if (
          typeof sub === "object" &&
          sub !== null &&
          "stream" in sub &&
          (sub as any).stream === StreamType.LOCATION_STREAM
        ) {
          const rate = (sub as any).rate;
          if (rate) {
            result.push({ packageName, rate });
          }
        }
      }
    }

    return result;
  }

  /**
   * Extract calendar subscriptions from all app subscriptions.
   * Returns list of package names subscribed to calendar events.
   */
  private getCalendarSubscriptions(): string[] {
    const result: string[] = [];

    for (const [packageName, subs] of this.subscriptions.entries()) {
      if (subs.has(StreamType.CALENDAR_EVENT)) {
        result.push(packageName);
      }
    }

    return result;
  }

  private getTranscriptionSubscriptions(): ExtendedStreamType[] {
    const subs: ExtendedStreamType[] = [];
    for (const set of this.subscriptions.values()) {
      for (const sub of set) {
        if (
          typeof sub === "string" &&
          sub.includes("transcription") &&
          !sub.includes("translation")
        ) {
          subs.push(sub);
        }
      }
    }
    return subs;
  }

  private getTranslationSubscriptions(): ExtendedStreamType[] {
    const subs: ExtendedStreamType[] = [];
    for (const set of this.subscriptions.values()) {
      for (const sub of set) {
        if (typeof sub === "string" && sub.includes("translation")) {
          subs.push(sub);
        }
      }
    }
    return subs;
  }

  private async syncManagers(): Promise<void> {
    try {
      const transcriptionSubs = this.getTranscriptionSubscriptions();
      await this.userSession.transcriptionManager.updateSubscriptions(
        transcriptionSubs,
      );
      const translationSubs = this.getTranslationSubscriptions();
      await this.userSession.translationManager.updateSubscriptions(
        translationSubs,
      );

      await Promise.all([
        this.userSession.transcriptionManager.ensureStreamsExist(),
        this.userSession.translationManager.ensureStreamsExist(),
      ]);

      // Pass location subscriptions to LocationManager for tier computation + relay
      const locationSubs = this.getLocationSubscriptions();
      this.userSession.locationManager.handleSubscriptionUpdate(locationSubs);

      // Pass calendar subscriptions to CalendarManager for relay
      const calendarSubs = this.getCalendarSubscriptions();
      this.userSession.calendarManager.handleSubscriptionUpdate(calendarSubs);
    } catch (error) {
      const logger = this.logger.child({ userId: this.userSession.userId });
      logger.error(error, "Error syncing managers with subscriptions");
    }
  }

  /**
   * Apply delta between old and new subscription sets to cached aggregates
   */
  private applyDelta(
    packageName: string,
    oldSet: Set<ExtendedStreamType>,
    newSet: Set<ExtendedStreamType>,
  ): void {
    this.logger.debug(
      {
        packageName,
        oldCount: oldSet.size,
        newCount: newSet.size,
        oldSubs: Array.from(oldSet),
        newSubs: Array.from(newSet),
      },
      "applyDelta called",
    );

    // Determine if this app needs transcription/PCM before and after
    const oldHasTranscription = this.hasTranscriptionLike(oldSet);
    const newHasTranscription = this.hasTranscriptionLike(newSet);
    const oldHasPCM = oldSet.has(StreamType.AUDIO_CHUNK);
    const newHasPCM = newSet.has(StreamType.AUDIO_CHUNK);

    // Update app tracking sets
    if (oldHasTranscription && !newHasTranscription) {
      this.appsWithTranscription.delete(packageName);
      this.logger.debug(
        { packageName, appsRemaining: this.appsWithTranscription.size },
        "App removed from transcription set",
      );
    } else if (!oldHasTranscription && newHasTranscription) {
      this.appsWithTranscription.add(packageName);
      this.logger.debug(
        { packageName, appsTotal: this.appsWithTranscription.size },
        "App added to transcription set",
      );
    }

    if (oldHasPCM && !newHasPCM) {
      this.appsWithPCM.delete(packageName);
      this.logger.debug(
        { packageName, appsRemaining: this.appsWithPCM.size },
        "App removed from PCM set",
      );
    } else if (!oldHasPCM && newHasPCM) {
      this.appsWithPCM.add(packageName);
      this.logger.debug(
        { packageName, appsTotal: this.appsWithPCM.size },
        "App added to PCM set",
      );
    }

    // Still update language stream counts for detailed tracking
    for (const sub of oldSet) {
      if (!newSet.has(sub) && isLanguageStream(sub)) {
        const prev = this.languageStreamCounts.get(sub) || 0;
        const next = prev - 1;
        if (next <= 0) this.languageStreamCounts.delete(sub);
        else this.languageStreamCounts.set(sub, next);
      }
    }
    for (const sub of newSet) {
      if (!oldSet.has(sub) && isLanguageStream(sub)) {
        const prev = this.languageStreamCounts.get(sub) || 0;
        this.languageStreamCounts.set(sub, prev + 1);
      }
    }

    this.logger.debug(
      {
        packageName,
        appsWithTranscription: Array.from(this.appsWithTranscription),
        appsWithPCM: Array.from(this.appsWithPCM),
      },
      "applyDelta completed - current state",
    );
  }

  /**
   * Check if a set of subscriptions contains transcription-like streams
   */
  private hasTranscriptionLike(subs: Set<ExtendedStreamType>): boolean {
    for (const sub of subs) {
      if (sub === StreamType.TRANSCRIPTION || sub === StreamType.TRANSLATION) {
        return true;
      }
      if (isLanguageStream(sub)) {
        const info = parseLanguageStream(sub as string);
        if (
          info &&
          (info.type === StreamType.TRANSCRIPTION ||
            info.type === StreamType.TRANSLATION)
        ) {
          return true;
        }
      }
    }
    return false;
  }
}

export default SubscriptionManager;
