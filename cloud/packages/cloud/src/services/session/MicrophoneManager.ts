/**
 * @fileoverview MicrophoneManager manages microphone state within a user session.
 * It encapsulates all microphone-related functionality that was previously
 * scattered throughout the WebSocket service.
 *
 * This follows the pattern used by other managers like DisplayManager and DashboardManager.
 *
 * IMPORTANT: This manager is responsible for telling the mobile app when to send audio.
 * If the mic state gets out of sync (e.g., mobile thinks mic is off but cloud has subscriptions),
 * transcription will silently fail with no audio data flowing.
 *
 * Key reliability features:
 * - Keep-alive: Periodically re-sends mic state to ensure mobile stays in sync
 * - Subscription change handling: Always re-evaluates and sends mic state when subscriptions change
 * - Glasses reconnect handling: Re-sends mic state when glasses reconnect
 * - Forced re-sync: Can be called to force mic state re-evaluation
 */

import { Logger } from "pino";

import { CloudToGlassesMessageType, MicrophoneStateChange } from "@mentra/sdk";

import { WebSocketReadyState } from "../websocket/types";

// import subscriptionService from "./subscription.service";
import UserSession from "./UserSession";

/**
 * Manages microphone state for a user session
 */
export class MicrophoneManager {
  private session: UserSession;
  private logger: Logger;

  // Track the current microphone state
  private enabled = false;

  // Debounce mechanism for state changes
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: boolean | null = null;
  private lastSentState = false;
  private lastSentRequiredData: Array<"pcm" | "transcription" | "pcm_or_transcription"> = [];
  private pendingRequiredData: Array<"pcm" | "transcription" | "pcm_or_transcription"> | null = null;

  // Debounce mechanism for subscription changes
  private subscriptionDebounceTimer: NodeJS.Timeout | null = null;

  // Keep-alive mechanism for microphone state
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private readonly KEEP_ALIVE_INTERVAL_MS = 10000; // 10 seconds

  // Mic-off holddown to avoid flapping during transient reconnects
  private micOffHolddownTimer: NodeJS.Timeout | null = null;
  private readonly MIC_OFF_HOLDDOWN_MS = 3000; // 3 seconds

  // Unauthorized audio detection
  private unauthorizedAudioTimer: NodeJS.Timeout | null = null;
  private readonly UNAUTHORIZED_AUDIO_DEBOUNCE_MS = 5000; // 5 seconds

  // Track last subscription check time to detect stale cache
  private lastSubscriptionCheckTime = 0;
  private readonly SUBSCRIPTION_CACHE_MAX_AGE_MS = 5000; // 5 seconds max cache age

  // Cached subscription state to avoid expensive repeated lookups
  private cachedSubscriptionState: {
    hasPCM: boolean;
    hasTranscription: boolean;
    hasMedia: boolean;
  } = {
    hasPCM: false,
    hasTranscription: false,
    hasMedia: false,
  };

  constructor(session: UserSession) {
    this.session = session;
    this.logger = session.logger.child({ service: "MicrophoneManager" });
    this.logger.info("MicrophoneManager initialized");

    // Initialize cached subscription state
    this.updateCachedSubscriptionState();
    this.lastSubscriptionCheckTime = Date.now();
  }

  /**
   * Update the microphone state with debouncing
   * Replicates the exact behavior of the original sendDebouncedMicrophoneStateChange
   *
   * @param isEnabled - Whether the microphone should be enabled
   * @param requiredData - Array of required data types
   * @param delay - Debounce delay in milliseconds (default: 1000ms)
   */
  updateState(
    isEnabled: boolean,
    requiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">,
    delay = 1000,
  ): void {
    this.logger.debug(`Updating microphone state: ${isEnabled}, delay: ${delay}ms`);

    if (this.debounceTimer === null) {
      // First call: send immediately and update lastSentState
      this.sendStateChangeToGlasses(isEnabled, requiredData);
      this.lastSentState = isEnabled;
      this.pendingState = isEnabled;
      this.lastSentRequiredData = Array.from(requiredData);
      this.pendingRequiredData = Array.from(requiredData);
      this.enabled = isEnabled;
    } else {
      // For subsequent calls, update pending state
      this.pendingState = isEnabled;
      this.pendingRequiredData = Array.from(requiredData);

      // Clear existing timer
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Set or reset the debounce timer
    this.debounceTimer = setTimeout(() => {
      // Only send if the final state differs from the last sent state
      // Also compare that all elements of the array are the same
      if (
        this.pendingState !== this.lastSentState ||
        this.hasRequiredDataChanged(this.pendingRequiredData!, this.lastSentRequiredData!)
      ) {
        this.logger.info(`Sending debounced microphone state change: ${this.pendingState}`);
        this.sendStateChangeToGlasses(this.pendingState!, this.pendingRequiredData!);
        this.lastSentState = this.pendingState!;
        this.lastSentRequiredData = this.pendingRequiredData!;
        this.enabled = this.pendingState!;

        this.session.liveKitManager.onMicStateChange();
      }

      // Update transcription service state
      this.updateTranscriptionState();

      // Inform LiveKitManager about mic state and media need
      // const hasMedia = this.cachedSubscriptionState.hasMedia;
      // this.session.liveKitManager.onMicStateChange(this.enabled);
      // this.session.liveKitManager.onMediaNeeded(hasMedia);

      // Update keep-alive timer based on final state
      this.updateKeepAliveTimer();

      // Cleanup: reset debounce timer
      this.debounceTimer = null;
      this.pendingState = null;
      this.pendingRequiredData = null;
    }, delay);
  }

  private hasRequiredDataChanged(
    newRequiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">,
    oldRequiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">,
  ): boolean {
    return (
      newRequiredData.length !== oldRequiredData.length ||
      newRequiredData.some((item, index) => item !== oldRequiredData[index])
    );
  }

  /**
   * Send microphone state change message to glasses
   * This replicates the exact message format from the original implementation
   */
  private sendStateChangeToGlasses(
    isEnabled: boolean,
    requiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">,
    isKeepAlive = false,
  ): void {
    if (!this.session.websocket || this.session.websocket.readyState !== WebSocketReadyState.OPEN) {
      this.logger.warn("Cannot send microphone state change: WebSocket not open");
      return;
    }

    try {
      // Check if we should bypass VAD for PCM-specific subscriptions
      const shouldBypassVad = this.shouldBypassVadForPCM();

      // TODO: Remove this type extension once the SDK is updated
      const message: MicrophoneStateChange = {
        type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
        sessionId: this.session.sessionId,
        isMicrophoneEnabled: isEnabled,
        requiredData: isEnabled ? requiredData : [],
        bypassVad: shouldBypassVad, // NEW: Include VAD bypass flag
        timestamp: new Date(),
      };

      this.session.websocket.send(JSON.stringify(message));
      // Only log actual state changes, not routine keepalives
      if (!isKeepAlive) {
        this.logger.debug({ message }, "Sent microphone state change message");
      }

      // Start or update keep-alive timer after successful send
      if (!isKeepAlive) {
        this.updateKeepAliveTimer();
      }
    } catch (error) {
      this.logger.error(error, "Error sending microphone state change");
    }
  }

  /**
   * Update cached subscription state
   * This is called when subscriptions change to avoid repeated expensive lookups
   */
  private updateCachedSubscriptionState(): void {
    const state = this.session.subscriptionManager.hasPCMTranscriptionSubscriptions();
    const previousState = { ...this.cachedSubscriptionState };

    this.cachedSubscriptionState = {
      hasPCM: state.hasPCM,
      hasTranscription: state.hasTranscription,
      hasMedia: state.hasMedia,
    };
    this.lastSubscriptionCheckTime = Date.now();

    // Log if state changed (important for debugging mic sync issues)
    if (previousState.hasMedia !== this.cachedSubscriptionState.hasMedia) {
      this.logger.info(
        {
          previous: previousState,
          current: this.cachedSubscriptionState,
        },
        `Subscription state changed: hasMedia ${previousState.hasMedia} -> ${this.cachedSubscriptionState.hasMedia}`,
      );
    } else {
      this.logger.debug(this.cachedSubscriptionState, "Updated cached subscription state");
    }
  }

  /**
   * Check if cached subscription state is stale and needs refresh
   */
  private isCacheStale(): boolean {
    return Date.now() - this.lastSubscriptionCheckTime > this.SUBSCRIPTION_CACHE_MAX_AGE_MS;
  }

  /**
   * Get fresh subscription state, refreshing cache if stale
   */
  private getFreshSubscriptionState(): { hasPCM: boolean; hasTranscription: boolean; hasMedia: boolean } {
    if (this.isCacheStale()) {
      this.logger.debug("Subscription cache is stale, refreshing");
      this.updateCachedSubscriptionState();
    }
    return this.cachedSubscriptionState;
  }

  /**
   * Check if we should bypass VAD for PCM-specific subscriptions
   * Bypass VAD when apps need PCM data (regardless of transcription)
   */
  private shouldBypassVadForPCM(): boolean {
    // Use cached state instead of calling service
    return this.cachedSubscriptionState.hasPCM;
  }

  calculateRequiredData(
    hasPCM: boolean,
    hasTranscription: boolean,
  ): Array<"pcm" | "transcription" | "pcm_or_transcription"> {
    const requiredData: Array<"pcm" | "transcription" | "pcm_or_transcription"> = [];
    // NOTE: For now online apps always need PCM data
    if (hasPCM || hasTranscription) {
      requiredData.push("pcm");
    }
    return requiredData;
  }

  /**
   * Update transcription service state based on current microphone state
   * Transcription is now handled by TranscriptionManager based on app subscriptions and VAD
   * The microphone state doesn't directly control transcription anymore
   */
  private updateTranscriptionState(): void {
    // Transcription is now controlled by:
    // 1. App subscriptions (via TranscriptionManager.updateSubscriptions)
    // 2. VAD events (via TranscriptionManager.restartFromActiveSubscriptions/stopAndFinalizeAll)
    //
    // The microphone state is informational and doesn't directly start/stop transcription
    this.logger.debug("Microphone state updated - transcription handled by TranscriptionManager");
  }

  /**
   * Get the current microphone state
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Handle glasses connection state changes
   * This replicates the behavior in the GLASSES_CONNECTION_STATE case
   *
   * IMPORTANT: On glasses reconnect, we MUST force a mic state resync.
   * This is critical because the mobile app may have lost track of mic state
   * during the reconnection process.
   */
  handleConnectionStateChange(status: string): void {
    if (status === "CONNECTED" || status === "RECONNECTED") {
      this.logger.info({ status, previousMicEnabled: this.enabled }, `Glasses ${status}, forcing mic state resync`);

      // CRITICAL: Force resync on glasses connect/reconnect
      // This ensures the mobile app has the correct mic state after any connection event
      this.forceResync();
    }
  }

  /**
   * Handle subscription changes with debouncing
   * This should be called when Apps update their subscriptions
   */
  handleSubscriptionChange(): void {
    // Clear any existing debounce timer
    if (this.subscriptionDebounceTimer) {
      clearTimeout(this.subscriptionDebounceTimer);
    }

    // Set new debounce timer to batch rapid subscription changes
    this.subscriptionDebounceTimer = setTimeout(() => {
      // Update cache when subscriptions change
      this.updateCachedSubscriptionState();

      const hasMediaSubscriptions = this.cachedSubscriptionState.hasMedia;
      const requiredData = this.calculateRequiredData(
        this.cachedSubscriptionState.hasPCM,
        this.cachedSubscriptionState.hasTranscription,
      );
      this.logger.info(
        {
          hasMediaSubscriptions,
          hasPCM: this.cachedSubscriptionState.hasPCM,
          hasTranscription: this.cachedSubscriptionState.hasTranscription,
          currentMicEnabled: this.enabled,
          requiredData,
        },
        `Subscription changed, media subscriptions: ${hasMediaSubscriptions}`,
      );
      // Inform LiveKitManager (mic state drives subscribe now)
      // Apply holddown when turning mic off to avoid flapping
      if (hasMediaSubscriptions) {
        // Cancel any pending mic-off holddown
        if (this.micOffHolddownTimer) {
          clearTimeout(this.micOffHolddownTimer);
          this.micOffHolddownTimer = null;
        }
        this.updateState(true, requiredData);
      } else {
        if (this.micOffHolddownTimer) {
          clearTimeout(this.micOffHolddownTimer);
        }
        this.micOffHolddownTimer = setTimeout(() => {
          // Re-evaluate before actually turning off
          this.updateCachedSubscriptionState();
          const stillNoMedia = !this.cachedSubscriptionState.hasMedia;
          const finalRequiredData = this.calculateRequiredData(
            this.cachedSubscriptionState.hasPCM,
            this.cachedSubscriptionState.hasTranscription,
          );
          if (stillNoMedia) {
            this.logger.info("Mic-off holddown complete, still no media subscriptions - turning mic off");
            this.updateState(false, finalRequiredData);
          } else {
            this.logger.info("Mic-off holddown complete, but media subscriptions now exist - keeping mic on");
          }
          this.micOffHolddownTimer = null;
        }, this.MIC_OFF_HOLDDOWN_MS);
      }
      this.subscriptionDebounceTimer = null;
    }, 100); // 100ms debounce - short enough to be responsive, long enough to batch rapid calls
  }

  /**
   * Force re-synchronization of mic state with mobile
   * This should be called when there's suspicion that mic state is out of sync
   * (e.g., after reconnection, after detecting audio when mic should be off)
   */
  forceResync(): void {
    this.logger.info("Forcing mic state re-synchronization");

    // Refresh subscription state from source of truth
    this.updateCachedSubscriptionState();

    const hasMediaSubscriptions = this.cachedSubscriptionState.hasMedia;
    const requiredData = this.calculateRequiredData(
      this.cachedSubscriptionState.hasPCM,
      this.cachedSubscriptionState.hasTranscription,
    );

    this.logger.info(
      {
        hasMediaSubscriptions,
        hasPCM: this.cachedSubscriptionState.hasPCM,
        hasTranscription: this.cachedSubscriptionState.hasTranscription,
        previousMicEnabled: this.enabled,
        requiredData,
      },
      `Force resync: setting mic to ${hasMediaSubscriptions}`,
    );

    // Force send the state change (bypass debounce)
    this.sendStateChangeToGlasses(hasMediaSubscriptions, requiredData);
    this.enabled = hasMediaSubscriptions;
    this.lastSentState = hasMediaSubscriptions;
    this.lastSentRequiredData = requiredData;

    // Update keep-alive timer
    this.updateKeepAliveTimer();
  }

  /**
   * Update microphone settings based on core status
   * This replicates the onboard mic setting update
   */
  // updateOnboardMicSetting(useOnboardMic: boolean): void {
  //   this.logger.info(`Updating onboard mic setting: ${useOnboardMic}`);
  //   // Update the setting in user preferences or session state
  //   // Implementation depends on how settings are stored
  // }

  /**
   * Update the keep-alive timer based on current state
   * Starts timer if mic is enabled and there are media subscriptions
   * Stops timer if mic is disabled or no media subscriptions
   */
  private updateKeepAliveTimer(): void {
    // Check if we should have a keep-alive timer running using cached state
    const shouldHaveKeepAlive = this.enabled && this.cachedSubscriptionState.hasMedia;

    if (shouldHaveKeepAlive && !this.keepAliveTimer) {
      // Start keep-alive timer (no logging - routine operation)
      this.keepAliveTimer = setInterval(() => {
        // Only send if WebSocket is still open
        if (this.session.websocket && this.session.websocket.readyState === WebSocketReadyState.OPEN) {
          // IMPORTANT: Refresh subscription state to catch any drift
          // This prevents issues where cached state becomes stale
          const freshState = this.getFreshSubscriptionState();

          if (freshState.hasMedia && this.enabled) {
            // Don't log routine keepalives - they create noise every 10 seconds
            this.sendStateChangeToGlasses(this.lastSentState, this.lastSentRequiredData, true);
          } else if (freshState.hasMedia && !this.enabled) {
            // IMPORTANT: We have media subscriptions but mic is marked as off
            // This indicates a state drift - force resync
            this.logger.warn(
              {
                enabled: this.enabled,
                hasMedia: freshState.hasMedia,
              },
              "Keep-alive detected state drift: subscriptions exist but mic disabled - forcing resync",
            );
            this.forceResync();
          } else {
            // No media subscriptions, stop the timer
            this.logger.debug("Keep-alive: no media subscriptions, stopping timer");
            this.stopKeepAliveTimer();
          }
        }
      }, this.KEEP_ALIVE_INTERVAL_MS);
    } else if (!shouldHaveKeepAlive && this.keepAliveTimer) {
      // Stop keep-alive timer
      this.stopKeepAliveTimer();
    }
  }

  /**
   * Stop the keep-alive timer
   */
  private stopKeepAliveTimer(): void {
    if (this.keepAliveTimer) {
      // No logging - routine operation
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * Called when audio data is received from the glasses
   * Checks if we're receiving unauthorized audio and sends mic off immediately
   * OR if we should be receiving audio but thought mic was off (state drift)
   */
  onAudioReceived(): void {
    // Skip if we're in the debounce period
    if (this.unauthorizedAudioTimer) {
      return;
    }

    // IMPORTANT: Use fresh subscription state, not cached
    // This catches scenarios where subscriptions changed but mic state wasn't updated
    const freshState = this.getFreshSubscriptionState();

    // Check if we SHOULD be receiving audio (subscriptions exist)
    if (freshState.hasMedia) {
      // We have subscriptions - audio is authorized
      // But check if our internal state is wrong
      if (!this.enabled) {
        this.logger.warn(
          {
            enabled: this.enabled,
            hasMedia: freshState.hasMedia,
            hasPCM: freshState.hasPCM,
            hasTranscription: freshState.hasTranscription,
          },
          "Receiving audio with subscriptions but mic marked disabled - state drift detected, forcing resync",
        );
        // State drift: we have subscriptions but thought mic was off
        // This can happen if subscription updates didn't properly trigger mic state change
        this.forceResync();
      }
      return;
    }

    // No subscriptions but receiving audio - this is unauthorized
    this.logger.warn(
      {
        enabled: this.enabled,
        hasMedia: freshState.hasMedia,
      },
      "Receiving unauthorized audio (no subscriptions) - forcing mic off immediately",
    );

    // Send mic off immediately
    const requiredData = this.calculateRequiredData(freshState.hasPCM, freshState.hasTranscription);
    this.sendStateChangeToGlasses(false, requiredData);

    // Update internal state
    this.enabled = false;
    this.lastSentState = false;
    this.lastSentRequiredData = requiredData;

    // Stop keep-alive since mic should be off
    this.stopKeepAliveTimer();

    // Start debounce timer to ignore further unauthorized audio for 5 seconds
    this.unauthorizedAudioTimer = setTimeout(() => {
      this.logger.debug("Unauthorized audio debounce period ended");
      // Update cached subscription state before resuming detection
      // This ensures we have fresh state in case subscriptions changed during debounce
      this.updateCachedSubscriptionState();
      this.unauthorizedAudioTimer = null;
    }, this.UNAUTHORIZED_AUDIO_DEBOUNCE_MS);
  }

  /**
   * Stop the unauthorized audio timer
   */
  private stopUnauthorizedAudioTimer(): void {
    if (this.unauthorizedAudioTimer) {
      clearTimeout(this.unauthorizedAudioTimer);
      this.unauthorizedAudioTimer = null;
    }
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.logger.info("Disposing MicrophoneManager");
    // Clear any timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.subscriptionDebounceTimer) {
      clearTimeout(this.subscriptionDebounceTimer);
      this.subscriptionDebounceTimer = null;
    }
    // Stop keep-alive timer
    this.stopKeepAliveTimer();
    // Stop unauthorized audio timer
    this.stopUnauthorizedAudioTimer();
    if (this.micOffHolddownTimer) {
      clearTimeout(this.micOffHolddownTimer);
      this.micOffHolddownTimer = null;
    }
  }
}

export default MicrophoneManager;
