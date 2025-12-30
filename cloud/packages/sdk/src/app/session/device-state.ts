/**
 * DeviceState - Reactive device state management via WebSocket
 *
 * Provides real-time Observable properties for device state (WiFi, battery, hotspot, etc.)
 * Uses flat structure matching GlassesInfo field names exactly.
 *
 * @example
 * ```typescript
 * // Synchronous read
 * if (session.device.state.wifiConnected) {
 *   console.log("Connected to:", session.device.state.wifiSsid.value);
 * }
 *
 * // Reactive subscription
 * session.device.state.wifiConnected.onChange((connected) => {
 *   console.log("WiFi status:", connected);
 * });
 *
 * session.device.state.batteryLevel.onChange((level) => {
 *   console.log("Battery:", level, "%");
 * });
 * ```
 */

import {Observable} from '../../utils/Observable';
import type {GlassesInfo} from '@mentra/types';
import type {AppSession} from './index';

export class DeviceState {
  // ============================================================================
  // WiFi Status Observables
  // ============================================================================

  /** WiFi connection status */
  public readonly wifiConnected: Observable<boolean>;

  /** WiFi network SSID (null if not connected) */
  public readonly wifiSsid: Observable<string | null>;

  /** WiFi local IP address (null if not connected) */
  public readonly wifiLocalIp: Observable<string | null>;

  // ============================================================================
  // Battery Status Observables
  // ============================================================================

  /** Glasses battery level (0-100, null if unknown) */
  public readonly batteryLevel: Observable<number | null>;

  /** Glasses charging status (null if unknown) */
  public readonly charging: Observable<boolean | null>;

  /** Case battery level (0-100, null if no case or unknown) */
  public readonly caseBatteryLevel: Observable<number | null>;

  /** Case charging status (null if no case or unknown) */
  public readonly caseCharging: Observable<boolean | null>;

  /** Case open/closed status (true = open, null if no case or unknown) */
  public readonly caseOpen: Observable<boolean | null>;

  /** Case removed status (true = glasses not in case, null if no case or unknown) */
  public readonly caseRemoved: Observable<boolean | null>;

  // ============================================================================
  // Hotspot Status Observables
  // ============================================================================

  /** Hotspot enabled status (null if not supported or unknown) */
  public readonly hotspotEnabled: Observable<boolean | null>;

  /** Hotspot SSID (null if disabled or unknown) */
  public readonly hotspotSsid: Observable<string | null>;

  // ============================================================================
  // Connection & Device Info Observables
  // ============================================================================

  /** Glasses connected to phone/cloud (true = connected) */
  public readonly connected: Observable<boolean>;

  /** Glasses model name (e.g., "even_g1", "xreal_air_2_pro") */
  public readonly modelName: Observable<string | null>;

  // ============================================================================
  // Internal State
  // ============================================================================

  private appSession: AppSession;

  constructor(appSession: AppSession) {
    this.appSession = appSession;

    // Initialize all observables with default/safe values
    // These will be updated when cloud sends DEVICE_STATE_UPDATE

    // WiFi (default: disconnected)
    this.wifiConnected = new Observable<boolean>(false);
    this.wifiSsid = new Observable<string | null>(null);
    this.wifiLocalIp = new Observable<string | null>(null);

    // Battery (default: unknown)
    this.batteryLevel = new Observable<number | null>(null);
    this.charging = new Observable<boolean | null>(null);
    this.caseBatteryLevel = new Observable<number | null>(null);
    this.caseCharging = new Observable<boolean | null>(null);
    this.caseOpen = new Observable<boolean | null>(null);
    this.caseRemoved = new Observable<boolean | null>(null);

    // Hotspot (default: disabled/unknown)
    this.hotspotEnabled = new Observable<boolean | null>(null);
    this.hotspotSsid = new Observable<string | null>(null);

    // Connection (default: disconnected)
    this.connected = new Observable<boolean>(false);
    this.modelName = new Observable<string | null>(null);
  }

  /**
   * Update device state from WebSocket message
   *
   * Called internally by AppSession when DEVICE_STATE_UPDATE message is received.
   * Only updates Observables for fields present in the state object.
   * Observables automatically notify listeners only if value changed.
   *
   * @param state - Partial device state (only changed fields, or full snapshot)
   * @internal
   */
  updateFromMessage(state: Partial<GlassesInfo>): void {
    // Connection state
    if (state.connected !== undefined) {
      this.connected.setValue(state.connected);
    }
    if (state.modelName !== undefined) {
      this.modelName.setValue(state.modelName);
    }

    // WiFi state
    if (state.wifiConnected !== undefined) {
      this.wifiConnected.setValue(state.wifiConnected);
    }
    if (state.wifiSsid !== undefined) {
      this.wifiSsid.setValue(state.wifiSsid ?? null);
    }
    if (state.wifiLocalIp !== undefined) {
      this.wifiLocalIp.setValue(state.wifiLocalIp ?? null);
    }

    // Battery state
    if (state.batteryLevel !== undefined) {
      this.batteryLevel.setValue(state.batteryLevel ?? null);
    }
    if (state.charging !== undefined) {
      this.charging.setValue(state.charging ?? null);
    }
    if (state.caseBatteryLevel !== undefined) {
      this.caseBatteryLevel.setValue(state.caseBatteryLevel ?? null);
    }
    if (state.caseCharging !== undefined) {
      this.caseCharging.setValue(state.caseCharging ?? null);
    }
    if (state.caseOpen !== undefined) {
      this.caseOpen.setValue(state.caseOpen ?? null);
    }
    if (state.caseRemoved !== undefined) {
      this.caseRemoved.setValue(state.caseRemoved ?? null);
    }

    // Hotspot state
    if (state.hotspotEnabled !== undefined) {
      this.hotspotEnabled.setValue(state.hotspotEnabled ?? null);
    }
    if (state.hotspotSsid !== undefined) {
      this.hotspotSsid.setValue(state.hotspotSsid ?? null);
    }
  }

  /**
   * Get snapshot of current device state
   *
   * Returns a plain object with current values of all Observables.
   * Useful for compatibility with REST-style code or debugging.
   *
   * @returns Current device state as GlassesInfo partial object
   *
   * @example
   * ```typescript
   * const currentState = session.device.state.getSnapshot();
   * console.log("Current state:", currentState);
   * ```
   */
  getSnapshot(): Partial<GlassesInfo> {
    return {
      // Connection
      connected: this.connected.value,
      modelName: this.modelName.value ?? undefined,

      // WiFi
      wifiConnected: this.wifiConnected.value,
      wifiSsid: this.wifiSsid.value ?? undefined,
      wifiLocalIp: this.wifiLocalIp.value ?? undefined,

      // Battery
      batteryLevel: this.batteryLevel.value ?? undefined,
      charging: this.charging.value ?? undefined,
      caseBatteryLevel: this.caseBatteryLevel.value ?? undefined,
      caseCharging: this.caseCharging.value ?? undefined,
      caseOpen: this.caseOpen.value ?? undefined,
      caseRemoved: this.caseRemoved.value ?? undefined,

      // Hotspot
      hotspotEnabled: this.hotspotEnabled.value ?? undefined,
      hotspotSsid: this.hotspotSsid.value ?? undefined,
    };
  }
}
