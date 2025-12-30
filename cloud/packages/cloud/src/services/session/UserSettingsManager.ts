 
// MentraOS/cloud/packages/cloud/src/services/session/UserSettingsManager.ts

/**
 * UserSettingsManager
 *
 * Session-scoped manager that integrates REST-based user settings with the active session.
 * Responsibilities:
 * - Maintain a session snapshot of user settings (loaded from UserSettings if requested).
 * - React to REST updates by updating the snapshot.
 * - Bridge specific keys to legacy behaviors to preserve backward compatibility:
 *   - metric_system_enabled (boolean) → broadcast legacy "augmentos_settings_update" with { metricSystemEnabled }
 *   - default_wearable (string) → delegate to DeviceManager to update model/capabilities immediately
 *
 * Notes:
 * - This manager does not persist settings; persistence happens in the REST layer (user-settings.api.ts).
 * - Legacy WS settings are not written to UserSettings; they continue to flow on their old path.
 * - Only metric_system_enabled is bridged in this phase. Other keys are not broadcast.
 */

import type { Logger } from "pino";

import { UserSettings } from "../../models/user-settings.model";
import { WebSocketReadyState } from "../websocket/types";

import type UserSession from "./UserSession";


export class UserSettingsManager {
  private readonly userSession: UserSession;
  private readonly logger: Logger;

  // In-session snapshot of user settings (client-defined keys)
  private snapshot: Record<string, any> = {};

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "UserSettingsManager" });
    this.logger.info(
      { userId: userSession.userId },
      "UserSettingsManager initialized",
    );
    this.load();
  }

  /**
   * Optionally load current settings from the canonical UserSettings model.
   * This is not required for the bridge to function, but useful for diagnostics.
   */
  async load(): Promise<void> {
    try {
      const email = this.userSession.userId.toLowerCase();
      const doc = await UserSettings.findOne({ email });
      const settings = doc?.getSettings() || {};
      this.snapshot = { ...settings };
      if (this.snapshot.default_wearable) {
        this.logger.info(
          { userId: email, wearableId: this.snapshot.default_wearable },
          "Default wearable loaded",
        );
        await this.userSession.deviceManager.setCurrentModel(
          this.snapshot.default_wearable,
        );
      }
      this.logger.info(
        { userId: email, keys: Object.keys(this.snapshot) },
        "User settings snapshot loaded",
      );
    } catch (error) {
      this.logger.error(
        error as Error,
        "Error loading user settings snapshot from database",
      );
    }
  }

  /**
   * Get a shallow copy of the current in-session settings snapshot
   */
  getSnapshot(): Record<string, any> {
    return { ...this.snapshot };
  }

  /**
   * Called after REST persistence to update the in-session snapshot
   * and trigger any necessary legacy bridges or session updates.
   *
   * @param updated Partial map of keys updated via REST
   */
  async onSettingsUpdatedViaRest(updated: Record<string, any>): Promise<void> {
    try {
      if (!updated || typeof updated !== "object") return;

      // Update the in-session snapshot
      const prev = { ...this.snapshot };
      for (const [key, value] of Object.entries(updated)) {
        if (value === null || value === undefined) {
          delete this.snapshot[key];
        } else {
          this.snapshot[key] = value;
        }
      }

      this.logger.info(
        {
          userId: this.userSession.userId,
          changedKeys: Object.keys(updated),
        },
        "Applied REST user settings update to session snapshot",
      );

      // Bridge specific keys to legacy behavior for backward compatibility
      await this.bridgeMetricSystemEnabledIfPresent(updated);
      await this.applyDefaultWearableIfPresent(updated);

      // Optionally log diff (debug)
      if (this.shouldDebug()) {
        this.logger.debug(
          {
            before: prev,
            after: this.snapshot,
            applied: updated,
          },
          "User settings snapshot updated (debug)",
        );
      }
    } catch (error) {
      this.logger.error(
        error as Error,
        "Error handling onSettingsUpdatedViaRest in UserSettingsManager",
      );
    }
  }

  /**
   * Cleanup manager state (called from UserSession.dispose)
   */
  dispose(): void {
    this.snapshot = {};
  }

  // ===== Internal helpers =====

  /**
   * Bridge for metric_system_enabled (boolean) → legacy AugmentOS settings update
   * - Maps to metricSystemEnabled (camelCase) and broadcasts "augmentos_settings_update"
   * - Targets Apps that are subscribed to the specific augmentos key
   */
  private async bridgeMetricSystemEnabledIfPresent(
    updated: Record<string, any>,
  ): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(updated, "metric_system_enabled"))
      return;

    try {
      const raw = updated["metric_system_enabled"];
      const next =
        typeof raw === "string" ? raw.toLowerCase() === "true" : Boolean(raw);

      const legacyKey = "metricSystemEnabled";
      const subscribedApps =
        this.userSession.subscriptionManager.getSubscribedAppsForAugmentosSetting(
          legacyKey,
        );

      if (!subscribedApps || subscribedApps.length === 0) {
        this.logger.info(
          {
            userId: this.userSession.userId,
            legacyKey,
            value: next,
          },
          "No Apps subscribed to augmentos setting; skipping legacy broadcast",
        );
        return;
      }

      const timestamp = new Date();
      const payload = {
        type: "augmentos_settings_update",
        // Maintain legacy sessionId format: `${sessionId}-${packageName}`
        // We'll set this per-app send loop.
        settings: { [legacyKey]: next },
        timestamp,
      };

      for (const packageName of subscribedApps) {
        const ws = this.userSession.appWebsockets.get(packageName);
        if (!ws || ws.readyState !== WebSocketReadyState.OPEN) continue;

        const message = {
          ...payload,
          sessionId: `${this.userSession.sessionId}-${packageName}`,
        };

        try {
          ws.send(JSON.stringify(message));
        } catch (sendError) {
          this.logger.error(
            sendError as Error,
            `Error sending augmentos_settings_update to App ${packageName}`,
          );
        }
      }

      this.logger.info(
        {
          userId: this.userSession.userId,
          legacyKey,
          value: next,
          appCount: subscribedApps.length,
        },
        "Bridged metric_system_enabled to legacy augmentos_settings_update",
      );
    } catch (error) {
      this.logger.error(
        error as Error,
        "Error bridging metric_system_enabled to legacy augmentos_settings_update",
      );
    }
  }

  /**
   * Apply default_wearable by delegating to DeviceManager
   * - Updates current model and capabilities immediately
   * - Sends CAPABILITIES_UPDATE and stops incompatible Apps (via DeviceManager)
   * - Updates User.glassesModels, PostHog, and analytics per DeviceManager's behavior
   */
  private async applyDefaultWearableIfPresent(
    updated: Record<string, any>,
  ): Promise<void> {
    if (!Object.prototype.hasOwnProperty.call(updated, "default_wearable"))
      return;

    const raw = updated["default_wearable"];
    const modelName =
      typeof raw === "string" ? raw.trim() : raw ? String(raw) : "";

    if (!modelName) {
      this.logger.warn(
        { userId: this.userSession.userId },
        "default_wearable provided but empty; ignoring",
      );
      return;
    }

    try {
      await this.userSession.deviceManager.setCurrentModel(modelName);
    } catch (error) {
      this.logger.error(
        error as Error,
        "Error applying default_wearable via DeviceManager",
      );
    }
  }

  private shouldDebug(): boolean {
    // Toggle extra debug logging here if desired
    return false;
  }
}

export default UserSettingsManager;
