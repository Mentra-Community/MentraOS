/**
 * @fileoverview Manages TPA subscriptions to data streams for a single user session.
 * Handles subscription lifecycle, history tracking, and access control within the session context.
 *
 * This class is instantiated per UserSession.
 */

import {
  StreamType,
  ExtendedStreamType,
  isLanguageStream,
  parseLanguageStream,
  createTranscriptionStream,
  UserSession // Keep UserSession for type checking if needed
} from '@augmentos/sdk';
import { ExtendedUserSession } from './session.service'; // Import ExtendedUserSession
import { Logger } from 'pino'; // Import Logger type
// import { logger as rootLogger } from "../logging";
// const logger = rootLogger.child({ service: 'subscription.manager' });

/**
 * Record of a subscription change for a specific app within this session
 */
interface SubscriptionHistory {
  timestamp: Date;
  subscriptions: ExtendedStreamType[];
  action: 'add' | 'remove' | 'update';
}

/**
 * Manages subscriptions for a single user session.
 */
export class SubscriptionManager {
  /**
   * Map of active subscriptions keyed by packageName
   * @private
   */
  private subscriptions = new Map<string, Set<ExtendedStreamType>>();

  /**
   * Map of subscription history keyed by packageName
   * @private
   */
  private history = new Map<string, SubscriptionHistory[]>();

  /**
   * Reference to the parent UserSession for context (e.g., logging)
   * @private
   */
  private userSession: ExtendedUserSession;
  private logger: Logger; // Store logger reference

  constructor(userSession: ExtendedUserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger; // Use the session's logger
    this.logger.info('[SubscriptionManager] Initialized.');
  }

  /**
   * Updates subscriptions for a specific TPA within this session.
   * @param packageName - TPA identifier
   * @param subscriptions - New set of subscriptions
   * @throws If invalid subscription types are requested
   */
  updateSubscriptions(
    packageName: string,
    subscriptions: ExtendedStreamType[]
  ): void {
    const currentSubs = this.subscriptions.get(packageName) || new Set();
    const action: SubscriptionHistory['action'] = currentSubs.size === 0 ? 'add' : 'update';

    this.logger.info(
      `[SubscriptionManager] Updating subscriptions for ${packageName} with:`, subscriptions
    );

    // Validate and process subscriptions (e.g., default transcription lang)
    const processedSubscriptions = subscriptions.map(sub =>
      sub === StreamType.TRANSCRIPTION ?
        createTranscriptionStream('en-US') : // Default to en-US if not specified
        sub
    );

    const validProcessedSubscriptions: ExtendedStreamType[] = [];
    for (const sub of processedSubscriptions) {
      if (!this.isValidSubscription(sub)) {
        this.logger.error(`[SubscriptionManager] Invalid subscription type requested by ${packageName}: ${sub}`);
        // Skip invalid subscription instead of throwing
      } else {
          validProcessedSubscriptions.push(sub);
      }
    }

    this.logger.info(
        `[SubscriptionManager] Processed valid subscriptions for ${packageName}:`, validProcessedSubscriptions
    );

    // Update subscriptions map
    this.subscriptions.set(packageName, new Set(validProcessedSubscriptions));

    // Record history
    this.addToHistory(packageName, {
      timestamp: new Date(),
      subscriptions: [...validProcessedSubscriptions],
      action
    });

    this.logger.info(
        `[SubscriptionManager] Successfully updated subscriptions for ${packageName}.`
    );
  }

  /**
   * Checks if any TPA in this session has media-related subscriptions.
   * @returns Boolean indicating if audio/transcription/translation subscriptions exist.
   */
  hasMediaSubscriptions(): boolean {
    for (const subs of this.subscriptions.values()) {
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
   * Gets all TPAs within this session subscribed to a specific stream type being broadcast.
   * Handles exact matches, wildcards, and base-type vs language-specific matching.
   * @param subscriptionToBroadcast - The specific stream type being broadcast (can be base or language-specific)
   * @returns Array of package names subscribed to the stream
   */
  getSubscribedApps(subscriptionToBroadcast: ExtendedStreamType): string[] {
    this.logger.debug(`[SubscriptionManager.getSubscribedApps] Looking for apps subscribed to: ${subscriptionToBroadcast}`);

    const subscribedApps = new Set<string>();
    const isBroadcastLang = isLanguageStream(subscriptionToBroadcast);
    const broadcastBaseType = isBroadcastLang ? parseLanguageStream(subscriptionToBroadcast)?.type : subscriptionToBroadcast;

    for (const [packageName, storedSubscriptions] of this.subscriptions.entries()) {
      this.logger.debug(`[SubscriptionManager.getSubscribedApps] Checking app: ${packageName} with stored subs: ${Array.from(storedSubscriptions)}`);

      for (const storedSub of storedSubscriptions) {
         this.logger.debug(`  -> Comparing broadcast '${subscriptionToBroadcast}' with stored '${storedSub}'`); // Use debug

        // 1. Exact match?
        if (storedSub === subscriptionToBroadcast) {
          this.logger.debug(`    MATCH (Exact): ${packageName} for ${subscriptionToBroadcast}`);
          subscribedApps.add(packageName);
          break;
        }

        // 2. Stored wildcard?
        if (storedSub === StreamType.ALL || storedSub === StreamType.WILDCARD) {
          this.logger.debug(`    MATCH (Wildcard): ${packageName} for ${subscriptionToBroadcast}`);
          subscribedApps.add(packageName);
          break;
        }

        // 3. Language/Base Type Matching Logic:
        const isStoredLang = isLanguageStream(storedSub);
        const storedBaseType = isStoredLang ? parseLanguageStream(storedSub)?.type : storedSub;

        // Case: Broadcast is specific lang, Stored is matching base type
        if (isBroadcastLang && !isStoredLang && storedSub === broadcastBaseType) {
           this.logger.debug(`    MATCH (Broadcast Specific, Stored Base): ${packageName} for ${subscriptionToBroadcast}`);
           subscribedApps.add(packageName);
           break;
        }

        // Case: Broadcast is base type, Stored is specific lang of that type
        if (!isBroadcastLang && isStoredLang && storedBaseType === subscriptionToBroadcast) {
           this.logger.debug(`    MATCH (Broadcast Base, Stored Specific): ${packageName} for ${subscriptionToBroadcast}`);
           subscribedApps.add(packageName);
           break;
        }
      }
    }

    const result = Array.from(subscribedApps);
    this.logger.debug(`[SubscriptionManager.getSubscribedApps] Found subscribed apps for ${subscriptionToBroadcast}: ${result}`);
    return result;
  }

  /**
   * Gets all active subscriptions for a specific TPA within this session.
   * @param packageName - TPA identifier
   * @returns Array of active subscriptions
   */
  getAppSubscriptions(packageName: string): ExtendedStreamType[] {
    const subs = this.subscriptions.get(packageName);
    return subs ? Array.from(subs) : [];
  }

  /**
   * Gets all subscriptions for all apps in this session.
   * Useful for generating client state.
   * @returns Map where keys are package names and values are arrays of subscriptions.
   */
  getAllSubscriptions(): Map<string, ExtendedStreamType[]> {
      const allSubsMap = new Map<string, ExtendedStreamType[]>();
      for (const [packageName, subsSet] of this.subscriptions.entries()) {
          allSubsMap.set(packageName, Array.from(subsSet));
      }
      return allSubsMap;
  }

  /**
   * Gets subscription history for a specific TPA within this session.
   * @param packageName - TPA identifier
   * @returns Array of historical subscription changes
   */
  getSubscriptionHistory(packageName: string): SubscriptionHistory[] {
    return this.history.get(packageName) || [];
  }

  /**
   * Removes all subscriptions for a specific TPA within this session.
   * @param packageName - TPA identifier
   */
  removeSubscriptions(packageName: string): void {
    if (this.subscriptions.has(packageName)) {
      const currentSubs = Array.from(this.subscriptions.get(packageName) || []);

      this.addToHistory(packageName, {
        timestamp: new Date(),
        subscriptions: currentSubs,
        action: 'remove'
      });

      this.subscriptions.delete(packageName);
      this.history.delete(packageName); // Remove history for the app when subscriptions are removed

      this.logger.info(`[SubscriptionManager] Removed all subscriptions for ${packageName}`);
    }
  }

  /**
   * Returns the minimal set of unique language-specific subscriptions across all TPAs in this session.
   * @returns Array of unique language-specific stream types (e.g., ["transcription:en-US", "translation:es-ES-to-en-US"])
   */
  getMinimalLanguageSubscriptions(): ExtendedStreamType[] {
    const languageSet = new Set<ExtendedStreamType>();
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        if (isLanguageStream(sub)) {
          languageSet.add(sub);
        }
      }
    }
    return Array.from(languageSet);
  }

  /**
   * Adds an entry to the subscription history for a specific app.
   * @param key - package name
   * @param entry - History entry to add
   * @private
   */
  private addToHistory(packageName: string, entry: SubscriptionHistory): void {
    const history = this.history.get(packageName) || [];
    history.push(entry);
    this.history.set(packageName, history);
  }

  /**
   * Validates a subscription type (basic StreamType or valid language stream format).
   * @param subscription - Subscription to validate
   * @returns Boolean indicating if the subscription is valid
   * @private
   */
  private isValidSubscription(subscription: ExtendedStreamType): boolean {
    // Check if it's one of the base StreamType enums
    if (Object.values(StreamType).includes(subscription as StreamType)) {
      return true;
    }
    // Check if it follows the language stream pattern
    if (isLanguageStream(subscription)) {
      return true;
    }
    return false;
  }
}