/**
 * @fileoverview MicrophoneManager manages microphone state within a user session.
 * It encapsulates all microphone-related functionality that was previously
 * scattered throughout the WebSocket service.
 * 
 * This follows the pattern used by other managers like DisplayManager and DashboardManager.
 */

import WebSocket from 'ws';
import {
  CloudToGlassesMessageType,
  MicrophoneStateChange,
} from '@augmentos/sdk';
import subscriptionService from './subscription.service';
import transcriptionService from '../processing/transcription.service';
import { Logger } from 'pino';
import UserSession from './UserSession';

/**
 * Manages microphone state for a user session
 */
export class MicrophoneManager {
  private session: UserSession;
  private logger: Logger;

  // Track the current microphone state
  private enabled: boolean = false;

  // Debounce mechanism for state changes
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: boolean | null = null;
  private lastSentState: boolean = false;

  // Debounce mechanism for subscription changes
  private subscriptionDebounceTimer: NodeJS.Timeout | null = null;

  constructor(session: UserSession) {
    this.session = session;
    this.logger = session.logger.child({ service: 'MicrophoneManager' });
    this.logger.info('MicrophoneManager initialized');
  }

  /**
   * Update the microphone state with debouncing
   * Replicates the exact behavior of the original sendDebouncedMicrophoneStateChange
   * 
   * @param isEnabled - Whether the microphone should be enabled
   * @param delay - Debounce delay in milliseconds (default: 1000ms)
   */
  updateState(isEnabled: boolean, delay: number = 1000): void {
    this.logger.debug(`Updating microphone state: ${isEnabled}, delay: ${delay}ms`);

    if (this.debounceTimer === null) {
      // First call: send immediately and update lastSentState
      this.sendStateChangeToGlasses(isEnabled);
      this.lastSentState = isEnabled;
      this.pendingState = isEnabled;
      this.enabled = isEnabled;
    } else {
      // For subsequent calls, update pending state
      this.pendingState = isEnabled;

      // Clear existing timer
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Set or reset the debounce timer
    this.debounceTimer = setTimeout(() => {
      // Only send if the final state differs from the last sent state
      if (this.pendingState !== this.lastSentState) {
        this.logger.info(`Sending debounced microphone state change: ${this.pendingState}`);
        this.sendStateChangeToGlasses(this.pendingState!);
        this.lastSentState = this.pendingState!;
        this.enabled = this.pendingState!;
      }

      // Update transcription service state
      this.updateTranscriptionState();

      // Cleanup: reset debounce timer
      this.debounceTimer = null;
      this.pendingState = null;
    }, delay);
  }

  /**
   * Send microphone state change message to glasses
   * This replicates the exact message format from the original implementation
   */
  private sendStateChangeToGlasses(isEnabled: boolean): void {
    if (!this.session.websocket || this.session.websocket.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send microphone state change: WebSocket not open');
      return;
    }

    try {
      const message: MicrophoneStateChange = {
        type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
        sessionId: this.session.sessionId,
        userSession: {
          sessionId: this.session.sessionId,
          userId: this.session.userId,
          startTime: this.session.startTime,
          // activeAppSessions: this.session.activeAppSessions || [],
          activeAppSessions: Array.from(this.session.runningApps),
          // loadingApps: Array.from(this.session.loadingApps),
          loadingApps: this.session.loadingApps,
          isTranscribing: this.session.isTranscribing || false,
        },
        isMicrophoneEnabled: isEnabled,
        timestamp: new Date(),
      };

      this.session.websocket.send(JSON.stringify(message));
      this.logger.debug({ message }, 'Sent microphone state change message');
    } catch (error) {
      this.logger.error(error, 'Error sending microphone state change');
    }
  }

  /**
   * Update transcription service state based on current microphone state
   * This replicates the transcription service integration from the original implementation
   */
  private updateTranscriptionState(): void {
    try {
      if (this.enabled) {
        this.logger.info('Starting transcription based on microphone state');
        transcriptionService.startTranscription(this.session);
      } else {
        this.logger.info('Stopping transcription based on microphone state');
        transcriptionService.stopTranscription(this.session);
      }
    } catch (error) {
      this.logger.error('Error updating transcription state:', error);
    }
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
   */
  handleConnectionStateChange(status: string): void {
    if (status === 'CONNECTED') {
      this.logger.info({ status }, 'Glasses connected, checking media subscriptions ' + status);
      const hasMediaSubscriptions = subscriptionService.hasMediaSubscriptions(this.session.sessionId);
      this.updateState(hasMediaSubscriptions);
    }
  }



  /**
   * Handle subscription changes with debouncing
   * This should be called when TPAs update their subscriptions
   */
  handleSubscriptionChange(): void {
    // Clear any existing debounce timer
    if (this.subscriptionDebounceTimer) {
      clearTimeout(this.subscriptionDebounceTimer);
    }

    // Set new debounce timer to batch rapid subscription changes
    this.subscriptionDebounceTimer = setTimeout(() => {
      const hasMediaSubscriptions = subscriptionService.hasMediaSubscriptions(this.session.sessionId);
      this.logger.info(`Subscription changed, media subscriptions: ${hasMediaSubscriptions}`);
      this.updateState(hasMediaSubscriptions);
      this.subscriptionDebounceTimer = null;
    }, 100); // 100ms debounce - short enough to be responsive, long enough to batch rapid calls
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
   * Cleanup resources
   */
  dispose(): void {
    this.logger.info('Disposing MicrophoneManager');
    // Clear any timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.subscriptionDebounceTimer) {
      clearTimeout(this.subscriptionDebounceTimer);
      this.subscriptionDebounceTimer = null;
    }
  }
}

export default MicrophoneManager;