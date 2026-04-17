/**
 * 🔧 Settings Manager Module
 *
 * Manages App settings with automatic synchronization and change notifications.
 * Provides type-safe access to settings with default values.
 */
import EventEmitter from "events";
import type { Logger } from "pino";
import { AppSetting, AppSettings } from "../../types";
import { ApiClient } from "./api-client";

/**
 * Change information for a single setting
 */
export interface SettingChange {
  oldValue: any;
  newValue: any;
}

/**
 * Map of setting keys to their change information
 */
export type SettingsChangeMap = Record<string, SettingChange>;

/**
 * Callback for when any setting changes
 */
export type SettingsChangeHandler = (changes: SettingsChangeMap) => void;

/**
 * Callback for when a specific setting changes
 */
export type SettingValueChangeHandler<T = any> = (newValue: T, oldValue: T) => void;

/**
 * Internal event names
 */
enum SettingsEvents {
  CHANGE = "settings:change",
  VALUE_CHANGE = "settings:value:",
}

/**
 * 🔧 Settings Manager
 *
 * Provides a type-safe interface for accessing and reacting to App settings.
 * Automatically synchronizes with MentraOS Cloud.
 */
export class SettingsManager {
  // Current settings values
  private settings: AppSettings = [];

  // Event emitter for change notifications
  private emitter = new EventEmitter();

  // API client for fetching settings
  private apiClient?: ApiClient;

  // Logger instance (injected via constructor for proper log level respect)
  private logger: Logger;

  // --- MentraOS settings event system ---
  private mentraosSettings: Record<string, any> = {};
  private mentraosEmitter = new EventEmitter();
  private subscribeFn?: (streams: string[]) => Promise<void>; // Added for auto-subscriptions

  /**
   * Create a new settings manager
   *
   * @param initialSettings Initial settings values (if available)
   * @param packageName Package name for the App
   * @param wsUrl WebSocket URL (for deriving HTTP API URL)
   * @param userId User ID (for authenticated requests)
   * @param subscribeFn Optional function to call to subscribe to streams
   * @param logger Logger instance from the parent session
   */
  constructor(
    initialSettings: AppSettings = [],
    packageName?: string,
    wsUrl?: string,
    userId?: string,
    subscribeFn?: (streams: string[]) => Promise<void>, // Added parameter
    logger?: Logger,
  ) {
    this.settings = [...initialSettings];
    this.subscribeFn = subscribeFn; // Store the subscribe function

    // Use provided logger or create a minimal no-op fallback
    if (logger) {
      this.logger = logger.child({ module: "settings" });
    } else {
      // Fallback: import the default logger (backward compat during migration)
      const { logger: defaultLogger } = require("../../logging/logger");
      this.logger = defaultLogger.child({ module: "settings" });
    }

    // Create API client if we have enough information
    if (packageName) {
      this.apiClient = new ApiClient(packageName, wsUrl, userId);
    }
  }

  /**
   * Configure the API client
   *
   * @param packageName Package name for the App
   * @param wsUrl WebSocket URL
   * @param userId User ID
   */
  configureApiClient(packageName: string, wsUrl: string, userId: string): void {
    if (!this.apiClient) {
      this.apiClient = new ApiClient(packageName, wsUrl, userId);
    } else {
      this.apiClient.setWebSocketUrl(wsUrl);
      this.apiClient.setUserId(userId);
    }
  }

  /**
   * Update the current settings
   * This is called internally when settings are loaded or changed
   *
   * @param newSettings New settings values
   * @returns Map of changed settings
   */
  updateSettings(newSettings: AppSettings): SettingsChangeMap {
    const changes: SettingsChangeMap = {};

    // Copy the new settings
    const updatedSettings = [...newSettings];

    // Detect changes comparing old and new settings
    for (const newSetting of updatedSettings) {
      const oldSetting = this.settings.find((s) => s.key === newSetting.key);

      // Skip if value hasn't changed
      if (oldSetting && this.areEqual(oldSetting.value, newSetting.value)) {
        continue;
      }

      // Record change
      changes[newSetting.key] = {
        oldValue: oldSetting?.value,
        newValue: newSetting.value,
      };
    }

    // Check for removed settings
    for (const oldSetting of this.settings) {
      const stillExists = updatedSettings.some((s) => s.key === oldSetting.key);

      if (!stillExists) {
        changes[oldSetting.key] = {
          oldValue: oldSetting.value,
          newValue: undefined,
        };
      }
    }

    // If there are changes, update the settings and emit events
    if (Object.keys(changes).length > 0) {
      this.settings = updatedSettings;
      this.emitChanges(changes);
    }

    return changes;
  }

  /**
   * Check if two setting values are equal
   *
   * @param a First value
   * @param b Second value
   * @returns True if the values are equal
   */
  private areEqual(a: any, b: any): boolean {
    // Simple equality check - for objects, this won't do a deep equality check
    // but for most setting values (strings, numbers, booleans) it works
    return a === b;
  }

  /**
   * Emit change events for updated settings
   *
   * @param changes Map of changed settings
   */
  private emitChanges(changes: SettingsChangeMap): void {
    // Emit the general change event
    this.emitter.emit(SettingsEvents.CHANGE, changes);

    // Emit individual value change events
    for (const [key, change] of Object.entries(changes)) {
      this.emitter.emit(`${SettingsEvents.VALUE_CHANGE}${key}`, change.newValue, change.oldValue);
    }
  }

  /**
   * 🔄 Listen for changes to any setting
   *
   * @param handler Function to call when settings change
   * @returns Function to remove the listener
   *
   * @example
   * ```typescript
   * settings.onChange((changes) => {
   *   console.log('Settings changed:', changes);
   * });
   * ```
   */
  onChange(handler: SettingsChangeHandler): () => void {
    this.emitter.on(SettingsEvents.CHANGE, handler);
    return () => this.emitter.off(SettingsEvents.CHANGE, handler);
  }

  /**
   * 🔄 Listen for changes to a specific setting
   *
   * @param key Setting key to monitor
   * @param handler Function to call when the setting changes
   * @returns Function to remove the listener
   *
   * @example
   * ```typescript
   * settings.onValueChange('transcribe_language', (newValue, oldValue) => {
   *   console.log(`Language changed from ${oldValue} to ${newValue}`);
   * });
   * ```
   */
  onValueChange<T = any>(key: string, handler: SettingValueChangeHandler<T>): () => void {
    const eventName = `${SettingsEvents.VALUE_CHANGE}${key}`;
    this.emitter.on(eventName, handler);
    return () => this.emitter.off(eventName, handler);
  }

  /**
   * 🔍 Check if a setting exists
   *
   * @param key Setting key to check
   * @returns True if the setting exists
   */
  has(key: string): boolean {
    return this.settings.some((s) => s.key === key);
  }

  /**
   * 🔍 Get all settings
   *
   * @returns Copy of all settings
   */
  getAll(): AppSettings {
    return [...this.settings];
  }

  /**
   * 🔍 Get a setting value with type safety
   *
   * @param key Setting key to get
   * @param defaultValue Default value if setting doesn't exist or is undefined
   * @returns Setting value or default value
   *
   * @example
   * ```typescript
   * const lineWidth = settings.get<number>('line_width', 30);
   * const language = settings.get<string>('transcribe_language', 'English');
   * ```
   */
  get<T = any>(key: string, defaultValue?: T): T {
    const setting = this.settings.find((s) => s.key === key);

    if (setting && setting.value !== undefined) {
      return setting.value as T;
    }

    return defaultValue as T;
  }

  /**
   * 🎛️ Get an MentraOS system setting value with optional default
   *
   * @param key MentraOS setting key (e.g., 'metricSystemEnabled', 'brightness')
   * @param defaultValue Default value to return if the setting is not found
   * @returns The setting value or the default value
   *
   * @example
   * ```typescript
   * const isMetric = settings.getMentraOS<boolean>('metricSystemEnabled', false);
   * const brightness = settings.getMentraOS<number>('brightness', 50);
   * ```
   */
  getMentraOS<T = any>(key: string, defaultValue?: T): T {
    const value = this.mentraosSettings[key];

    if (value !== undefined) {
      return value as T;
    }

    return defaultValue as T;
  }

  /**
   * 🔍 Find a setting by key
   *
   * @param key Setting key to find
   * @returns Setting object or undefined
   */
  getSetting(key: string): AppSetting | undefined {
    return this.settings.find((s) => s.key === key);
  }

  /**
   * 🔄 Fetch settings from the cloud
   * This is generally not needed since settings are automatically kept in sync,
   * but can be used to force a refresh if needed.
   *
   * @returns Promise that resolves to the updated settings
   * @throws Error if the API client is not configured or the request fails
   */
  async fetch(): Promise<AppSettings> {
    if (!this.apiClient) {
      throw new Error("Settings API client is not configured");
    }

    try {
      const newSettings = await this.apiClient.fetchSettings();
      this.updateSettings(newSettings);
      return this.settings;
    } catch (error) {
      this.logger.error({ error }, "Error fetching settings");
      throw error;
    }
  }

  /**
   * 🎛️ Listen for changes to a specific MentraOS setting (e.g., metricSystemEnabled)
   *
   * @param key The mentraosSettings key to listen for (e.g., 'metricSystemEnabled')
   * @param handler Function to call when the value changes
   * @returns Function to remove the listener
   *
   * @example
   * ```typescript
   * settings.onMentraosChange('metricSystemEnabled', (isMetric, wasMetric) => {
   *   console.log(`Units changed: ${wasMetric ? 'metric' : 'imperial'} → ${isMetric ? 'metric' : 'imperial'}`);
   * });
   * ```
   */
  onMentraosChange<T = any>(key: string, handler: SettingValueChangeHandler<T>): () => void {
    return this.onMentraosSettingChange(key, handler);
  }

  /**
   * Listen for changes to a specific MentraOS setting (e.g., metricSystemEnabled)
   * This is a convenience wrapper for onValueChange for well-known mentraosSettings keys.
   * @param key The mentraosSettings key to listen for (e.g., 'metricSystemEnabled')
   * @param handler Function to call when the value changes
   * @returns Function to remove the listener
   * @deprecated Use onMentraosChange instead
   */
  onMentraosSettingsChange<T = any>(key: string, handler: SettingValueChangeHandler<T>): () => void {
    return this.onMentraosSettingChange(key, handler);
  }

  /**
   * Update the current MentraOS settings
   * Compares new and old values, emits per-key events, and updates stored values.
   * @param newSettings The new MentraOS settings object
   */
  updateMentraosSettings(newSettings: Record<string, any>): void {
    const oldSettings = this.mentraosSettings;
    this.logger.debug({ newSettings }, `[SettingsManager] Updating MentraOS settings. New settings`);
    for (const key of Object.keys(newSettings)) {
      const oldValue = oldSettings[key];
      const newValue = newSettings[key];
      if (oldValue !== newValue) {
        this.logger.debug(
          `[SettingsManager] MentraOS setting '${key}' changed: ${oldValue} -> ${newValue}. Emitting event.`,
        );
        this.mentraosEmitter.emit(`augmentos:value:${key}`, newValue, oldValue);
      }
    }
    // Also handle keys that might have been removed from newSettings but existed in oldSettings
    for (const key of Object.keys(oldSettings)) {
      if (!(key in newSettings)) {
        this.logger.debug(
          `[SettingsManager] MentraOS setting '${key}' removed. Old value: ${oldSettings[key]}. Emitting event with undefined newValue.`,
        );
        this.mentraosEmitter.emit(`augmentos:value:${key}`, undefined, oldSettings[key]);
      }
    }
    this.mentraosSettings = { ...newSettings };
    this.logger.debug(
      { mentraosSettings: this.mentraosSettings },
      `[SettingsManager] Finished updating MentraOS settings. Current state:`,
    );
  }

  /**
   * Subscribe to changes for a specific MentraOS setting (e.g., 'metricSystemEnabled')
   * @param key The MentraOS setting key to listen for
   * @param handler Function to call when the value changes (newValue, oldValue)
   * @returns Function to remove the listener
   */
  onMentraosSettingChange<T = any>(key: string, handler: (newValue: T, oldValue: T) => void): () => void {
    const eventName = `augmentos:value:${key}`;
    this.logger.debug(`[SettingsManager] Registering handler for MentraOS setting '${key}' on event '${eventName}'.`);
    this.mentraosEmitter.on(eventName, (...args) => {
      this.logger.debug({ args }, `[SettingsManager] MentraOS setting '${key}' event fired. Args:`);
      handler(...(args as [T, T]));
    });

    if (this.subscribeFn) {
      const subscriptionKey = `augmentos:${key}`;
      this.logger.debug(`[SettingsManager] Calling subscribeFn for stream '${subscriptionKey}'.`);
      this.subscribeFn([subscriptionKey])
        .then(() => {
          this.logger.debug(`[SettingsManager] subscribeFn resolved for stream '${subscriptionKey}'.`);
        })
        .catch((err) => {
          this.logger.error(`[SettingsManager] subscribeFn failed for stream '${subscriptionKey}':`, err);
        });
    } else {
      this.logger.warn(
        `[SettingsManager] 'subscribeFn' not provided. Cannot auto-subscribe for MentraOS setting '${key}'. Manual App subscription might be required.`,
      );
    }

    return () => {
      this.logger.debug(
        `[SettingsManager] Unregistering handler for MentraOS setting '${key}' from event '${eventName}'.`,
      );
      this.mentraosEmitter.off(eventName, handler as (newValue: unknown, oldValue: unknown) => void);
    };
  }

  /**
   * Get the current value of an MentraOS setting
   */
  getMentraosSetting<T = any>(key: string, defaultValue?: T): T {
    this.logger.debug({ key, mentraosSettings: this.mentraosSettings }, `Getting MentraOS setting '${key}'`);
    if (key in this.mentraosSettings) {
      return this.mentraosSettings[key] as T;
    }
    return defaultValue as T;
  }
}
