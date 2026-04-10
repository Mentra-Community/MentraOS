/**
 * DeviceManager — Consolidated Device State, Hardware Events & Capabilities
 *
 * Owns all device-related concerns for a MentraSession:
 *
 * - **Reactive state** — Observable properties for connection, battery, WiFi,
 *   hotspot, and case status (mirrors the legacy DeviceState pattern).
 * - **Hardware events** — Button presses, head position, touch gestures,
 *   battery updates, and VPS coordinates, all routed from the DataStreamRouter.
 * - **Capabilities** — Device capability profile received at connection time
 *   and updated mid-session when the glasses model changes.
 * - **Actions** — Outbound commands like `requestWifiSetup`.
 *
 * All handler registrations return a cleanup function. Subscriptions are
 * managed automatically — `addSubscription` is called when the first handler
 * for a stream is registered, and `removeSubscription` when the last is removed.
 *
 * @example
 * ```ts
 * // Reactive state
 * device.state.batteryLevel.onChange((level) => {
 *   console.log("Battery:", level, "%");
 * });
 *
 * // Hardware events
 * const stop = device.onButtonPress((e) => {
 *   console.log(e.buttonId, e.pressType);
 * });
 *
 * // Filtered touch events
 * device.onTouchEvent("double_tap", (e) => {
 *   console.log("Double tap!", e);
 * });
 *
 * // Capabilities
 * device.onCapabilitiesChange((caps) => {
 *   console.log("Device supports camera:", !!caps?.camera);
 * });
 *
 * // Actions
 * device.requestWifiSetup("App needs internet for sync");
 *
 * // Cleanup
 * stop();
 * ```
 *
 * @module
 */

import { Observable } from "../../utils/Observable";
import { StreamType } from "../../types/streams";
import type { PermissionsManager } from "./PermissionsManager";

// ─── Event Types ────────────────────────────────────────────────────────────

/**
 * Button press event from the glasses hardware.
 */
export interface ButtonPressEvent {
  /** Identifier of the button that was pressed. */
  buttonId: string;
  /** Whether the press was short or long. */
  pressType: "short" | "long";
}

/**
 * Head position event from the IMU.
 */
export interface HeadPositionEvent {
  /** Current head position. */
  position: "up" | "down";
}

/**
 * Normalised touch/gesture event from the glasses touchpad.
 *
 * Raw wire fields (`gesture_name`, `device_model`) are normalised to
 * `gesture` and `model` for a cleaner developer experience.
 */
export interface TouchEventData {
  /** Normalised gesture name (e.g. "double_tap", "forward_swipe"). */
  gesture: string;
  /** Normalised device model name. */
  model: string;
  /** Timestamp of the gesture. */
  timestamp: Date | string;
  /** The original raw data, preserved for advanced use cases. */
  [key: string]: any;
}

/**
 * Glasses battery update event.
 */
export interface BatteryUpdateEvent {
  /** Battery level 0–100. */
  level: number;
  /** Whether the glasses are currently charging. */
  charging: boolean;
  /** Estimated minutes remaining (if available). */
  timeRemaining?: number;
}

// ─── Dependency Types ───────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession into the DeviceManager.
 */
export interface DeviceManagerDeps {
  /** DataStreamRouter — register for stream-type events. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Subscribe to a data stream (sent to cloud). */
  addSubscription: (stream: string) => void;
  /** Unsubscribe from a data stream. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary message to the cloud. */
  sendMessage: (message: any) => void;
  /** Session-scoped logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** Returns the current app's package name. */
  getPackageName: () => string;
  /** Returns the active session ID. */
  getSessionId: () => string;
  /** PermissionsManager for gating protected streams. */
  permissions: PermissionsManager;
}

// ─── Reactive Device State ──────────────────────────────────────────────────

/**
 * Read-only reactive device state container.
 *
 * Every property is an {@link Observable} — call `.value` for synchronous
 * reads or `.onChange(cb)` for reactive subscriptions.
 */
export interface DeviceStateShape {
  readonly connected: Observable<boolean>;
  readonly modelName: Observable<string | null>;
  readonly batteryLevel: Observable<number | null>;
  readonly charging: Observable<boolean | null>;
  readonly caseBatteryLevel: Observable<number | null>;
  readonly caseCharging: Observable<boolean | null>;
  readonly caseOpen: Observable<boolean | null>;
  readonly caseRemoved: Observable<boolean | null>;
  readonly wifiConnected: Observable<boolean>;
  readonly wifiSsid: Observable<string | null>;
  readonly wifiLocalIp: Observable<string | null>;
  readonly hotspotEnabled: Observable<boolean | null>;
  readonly hotspotSsid: Observable<string | null>;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Normalise raw touch event data from the wire format.
 *
 * - `gesture_name` → `gesture`
 * - `device_model`  → `model`
 */
function normaliseTouchEvent(raw: any): TouchEventData {
  return {
    ...raw,
    gesture: raw.gesture_name ?? raw.gesture ?? "unknown",
    model: raw.device_model ?? raw.model ?? "unknown",
    timestamp: raw.timestamp ?? new Date().toISOString(),
  };
}

// ─── DeviceManager ──────────────────────────────────────────────────────────

/**
 * Manages all device-related state, hardware events, capabilities, and actions.
 *
 * Created by MentraSession and exposed as `session.device`.
 */
export class DeviceManager {
  // ─── Reactive State ───────────────────────────────────────────────────

  /** Reactive device state observables. */
  readonly state: DeviceStateShape;

  // ─── Capabilities ─────────────────────────────────────────────────────

  /** Current device capabilities (set from CONNECTION_ACK). */
  capabilities: any = null;

  // ─── Private ──────────────────────────────────────────────────────────

  private deps: DeviceManagerDeps;
  private permissions: PermissionsManager;

  /** Internal mutable references to observables (state exposes them read-only). */
  private readonly _connected: Observable<boolean>;
  private readonly _modelName: Observable<string | null>;
  private readonly _batteryLevel: Observable<number | null>;
  private readonly _charging: Observable<boolean | null>;
  private readonly _caseBatteryLevel: Observable<number | null>;
  private readonly _caseCharging: Observable<boolean | null>;
  private readonly _caseOpen: Observable<boolean | null>;
  private readonly _caseRemoved: Observable<boolean | null>;
  private readonly _wifiConnected: Observable<boolean>;
  private readonly _wifiSsid: Observable<string | null>;
  private readonly _wifiLocalIp: Observable<string | null>;
  private readonly _hotspotEnabled: Observable<boolean | null>;
  private readonly _hotspotSsid: Observable<string | null>;

  /** Capabilities-change listeners. */
  private capabilitiesListeners: Set<(caps: any) => void> = new Set();

  /**
   * Ref-counted handler bookkeeping per stream key.
   *
   * Tracks the number of active handlers for each stream so that
   * `addSubscription` / `removeSubscription` are called exactly once
   * when the first handler is added / last handler is removed.
   */
  private handlerCounts: Map<string, number> = new Map();

  /** Cleanup functions returned by router/messageHandlers registrations. */
  private cleanups: Array<() => void> = [];

  constructor(deps: DeviceManagerDeps) {
    this.deps = deps;
    this.permissions = deps.permissions;

    // ── Initialise Observables ────────────────────────────────────────
    this._connected = new Observable<boolean>(false);
    this._modelName = new Observable<string | null>(null);
    this._batteryLevel = new Observable<number | null>(null);
    this._charging = new Observable<boolean | null>(null);
    this._caseBatteryLevel = new Observable<number | null>(null);
    this._caseCharging = new Observable<boolean | null>(null);
    this._caseOpen = new Observable<boolean | null>(null);
    this._caseRemoved = new Observable<boolean | null>(null);
    this._wifiConnected = new Observable<boolean>(false);
    this._wifiSsid = new Observable<string | null>(null);
    this._wifiLocalIp = new Observable<string | null>(null);
    this._hotspotEnabled = new Observable<boolean | null>(null);
    this._hotspotSsid = new Observable<string | null>(null);

    // Expose as read-only shape
    this.state = {
      connected: this._connected,
      modelName: this._modelName,
      batteryLevel: this._batteryLevel,
      charging: this._charging,
      caseBatteryLevel: this._caseBatteryLevel,
      caseCharging: this._caseCharging,
      caseOpen: this._caseOpen,
      caseRemoved: this._caseRemoved,
      wifiConnected: this._wifiConnected,
      wifiSsid: this._wifiSsid,
      wifiLocalIp: this._wifiLocalIp,
      hotspotEnabled: this._hotspotEnabled,
      hotspotSsid: this._hotspotSsid,
    };

    // ── Register message handlers ─────────────────────────────────────
    this.cleanups.push(
      deps.messageHandlers.register("device_state_update", (msg: any) => {
        this.handleDeviceStateUpdate(msg);
      }),
    );
    this.cleanups.push(
      deps.messageHandlers.register("capabilities_update", (msg: any) => {
        this.handleCapabilitiesUpdate(msg);
      }),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Hardware Events
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Listen for physical button press events on the glasses.
   *
   * @param handler - Called with {@link ButtonPressEvent} for every press
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * const stop = device.onButtonPress((e) => {
   *   if (e.pressType === "long") {
   *     console.log("Long press on", e.buttonId);
   *   }
   * });
   * ```
   */
  onButtonPress(handler: (event: ButtonPressEvent) => void): () => void {
    return this.addStreamHandler(StreamType.BUTTON_PRESS, (_st, data) => {
      handler({
        buttonId: data.buttonId ?? data.button_id ?? "unknown",
        pressType: data.pressType ?? data.press_type ?? "short",
      });
    });
  }

  /**
   * Listen for head position (up/down) events from the IMU.
   *
   * @param handler - Called with {@link HeadPositionEvent} on position change
   * @returns Cleanup function to remove the handler
   */
  onHeadPosition(handler: (event: HeadPositionEvent) => void): () => void {
    return this.addStreamHandler(StreamType.HEAD_POSITION, (_st, data) => {
      handler({
        position: data.position ?? "down",
      });
    });
  }

  /**
   * Listen for touch/gesture events from the glasses touchpad.
   *
   * Overloaded:
   * - `onTouchEvent(handler)` — all touch events
   * - `onTouchEvent(gesture, handler)` — only events matching the given gesture
   *
   * @param gestureOrHandler - A gesture name string, or a handler for all events
   * @param handler - Handler when the first argument is a gesture name
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * // All gestures
   * device.onTouchEvent((e) => console.log(e.gesture));
   *
   * // Specific gesture
   * device.onTouchEvent("double_tap", (e) => console.log("Double tap!"));
   * ```
   */
  onTouchEvent(handler: (event: TouchEventData) => void): () => void;
  onTouchEvent(gesture: string, handler: (event: TouchEventData) => void): () => void;
  onTouchEvent(gestures: string[], handler: (event: TouchEventData) => void): () => void;
  onTouchEvent(
    gestureOrHandler: string | string[] | ((event: TouchEventData) => void),
    handler?: (event: TouchEventData) => void,
  ): () => void {
    if (Array.isArray(gestureOrHandler)) {
      // Subscribe to multiple gestures, single cleanup
      const gestures = gestureOrHandler as string[];
      const cleanups: Array<() => void> = [];
      for (const gesture of gestures) {
        const gestureStream = `${StreamType.TOUCH_EVENT}:${gesture}`;
        cleanups.push(this.addStreamHandler(gestureStream, (_st, data) => {
          handler!(normaliseTouchEvent(data));
        }));
      }
      return () => { for (const fn of cleanups) fn(); };
    }

    if (typeof gestureOrHandler === "function") {
      // Subscribe to all touch events
      return this.addStreamHandler(StreamType.TOUCH_EVENT, (_st, data) => {
        gestureOrHandler(normaliseTouchEvent(data));
      });
    }

    // Subscribe to a specific gesture via "touch_event:{gesture}" stream key
    const gesture = gestureOrHandler;
    const gestureStream = `${StreamType.TOUCH_EVENT}:${gesture}`;
    return this.addStreamHandler(gestureStream, (_st, data) => {
      handler!(normaliseTouchEvent(data));
    });
  }



  /**
   * Listen for glasses battery update events.
   *
   * Also updates the reactive `state.batteryLevel` and `state.charging` observables.
   *
   * @param handler - Called with {@link BatteryUpdateEvent} on each update
   * @returns Cleanup function to remove the handler
   */
  onBatteryUpdate(handler: (event: BatteryUpdateEvent) => void): () => void {
    return this.addStreamHandler(StreamType.GLASSES_BATTERY_UPDATE, (_st, data) => {
      // Update reactive state from the battery event
      if (data.level !== undefined) {
        this._batteryLevel.setValue(data.level);
      }
      if (data.charging !== undefined) {
        this._charging.setValue(data.charging);
      }

      handler({
        level: data.level ?? 0,
        charging: data.charging ?? false,
        timeRemaining: data.timeRemaining ?? data.time_remaining,
      });
    });
  }

  /**
   * Listen for VPS (Visual Positioning System) coordinate updates.
   *
   * @param handler - Called with raw VPS coordinate data
   * @returns Cleanup function to remove the handler
   */
  onVpsCoordinates(handler: (event: any) => void): () => void {
    return this.addStreamHandler(StreamType.VPS_COORDINATES, (_st, data) => {
      handler(data);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Actions
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Request the user to set up WiFi on their glasses.
   *
   * Sends a `request_wifi_setup` message to the cloud, which prompts
   * the companion app to display a WiFi configuration flow.
   *
   * @param reason - Optional human-readable reason shown to the user
   *
   * @example
   * ```ts
   * device.requestWifiSetup("This app needs WiFi for real-time sync");
   * ```
   */
  requestWifiSetup(reason?: string): void {
    this.deps.logger.info(`DeviceManager: Requesting WiFi setup${reason ? ` — ${reason}` : ""}`);
    this.deps.sendMessage({
      type: "request_wifi_setup",
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Capabilities
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to device capability changes.
   *
   * Called when capabilities are first received (CONNECTION_ACK) and
   * whenever the device model or capabilities change mid-session.
   *
   * @param handler - Called with the new capabilities object
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```ts
   * device.onCapabilitiesChange((caps) => {
   *   if (caps?.camera?.photo) {
   *     console.log("Camera supports photos");
   *   }
   * });
   * ```
   */
  onCapabilitiesChange(handler: (caps: any) => void): () => void {
    this.capabilitiesListeners.add(handler);
    return () => {
      this.capabilitiesListeners.delete(handler);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Internal — Called by MentraSession
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Handle a `device_state_update` message from the cloud.
   *
   * Updates all matching Observable properties. Only fields present in
   * the message are touched — Observables for absent fields keep their
   * current value.
   *
   * @param message - The raw device_state_update message
   * @internal
   */
  handleDeviceStateUpdate(message: any): void {
    const state = message?.state ?? message?.data ?? message;
    if (!state) {
      this.deps.logger.debug("DeviceManager: Received empty device_state_update");
      return;
    }

    this.deps.logger.debug("DeviceManager: Processing device state update");

    // Connection
    if (state.connected !== undefined) this._connected.setValue(state.connected);
    if (state.modelName !== undefined) this._modelName.setValue(state.modelName);

    // WiFi
    if (state.wifiConnected !== undefined) this._wifiConnected.setValue(state.wifiConnected);
    if (state.wifiSsid !== undefined) this._wifiSsid.setValue(state.wifiSsid ?? null);
    if (state.wifiLocalIp !== undefined) this._wifiLocalIp.setValue(state.wifiLocalIp ?? null);

    // Battery
    if (state.batteryLevel !== undefined) this._batteryLevel.setValue(state.batteryLevel ?? null);
    if (state.charging !== undefined) this._charging.setValue(state.charging ?? null);
    if (state.caseBatteryLevel !== undefined) this._caseBatteryLevel.setValue(state.caseBatteryLevel ?? null);
    if (state.caseCharging !== undefined) this._caseCharging.setValue(state.caseCharging ?? null);
    if (state.caseOpen !== undefined) this._caseOpen.setValue(state.caseOpen ?? null);
    if (state.caseRemoved !== undefined) this._caseRemoved.setValue(state.caseRemoved ?? null);

    // Hotspot
    if (state.hotspotEnabled !== undefined) this._hotspotEnabled.setValue(state.hotspotEnabled ?? null);
    if (state.hotspotSsid !== undefined) this._hotspotSsid.setValue(state.hotspotSsid ?? null);
  }

  /**
   * Handle a `capabilities_update` message from the cloud.
   *
   * Extracts the capabilities payload and delegates to {@link setCapabilities}.
   *
   * @param message - The raw capabilities_update message
   * @internal
   */
  handleCapabilitiesUpdate(message: any): void {
    const caps = message?.capabilities ?? message?.data?.capabilities ?? null;
    const modelName = message?.modelName ?? message?.data?.modelName ?? null;

    if (modelName) {
      this._modelName.setValue(modelName);
    }

    this.setCapabilities(caps);
  }

  /**
   * Directly set the device capabilities.
   *
   * Called by MentraSession from the CONNECTION_ACK payload, or by
   * {@link handleCapabilitiesUpdate} for mid-session updates.
   *
   * @param caps - The capabilities object (or null)
   * @internal
   */
  setCapabilities(caps: any): void {
    this.capabilities = caps;
    this.deps.logger.info(`DeviceManager: Capabilities ${caps ? "updated" : "cleared"}`);

    // Notify listeners
    for (const listener of this.capabilitiesListeners) {
      try {
        listener(caps);
      } catch (err) {
        this.deps.logger.error(
          `DeviceManager: Error in capabilities listener: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Remove all tracked handlers and clear listeners.
   *
   * Called by MentraSession during disconnect/cleanup.
   *
   * @internal
   */
  destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }

    this.cleanups.length = 0;
    this.handlerCounts.clear();
    this.capabilitiesListeners.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private — Stream Handler Management
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Register a handler on the DataStreamRouter for a given stream key,
   * managing subscription lifecycle automatically.
   *
   * - Calls `deps.addSubscription` when the first handler for a key is added.
   * - Calls `deps.removeSubscription` when the last handler for a key is removed.
   *
   * @param streamKey - The stream type or prefixed stream key
   * @param handler - The stream handler function
   * @returns Cleanup function that unregisters the handler and manages subscription
   */
  private addStreamHandler(
    streamKey: string,
    handler: (streamType: string, data: any, message: any) => void,
  ): () => void {
    const currentCount = this.handlerCounts.get(streamKey) ?? 0;

    // First handler for this stream — subscribe
    if (currentCount === 0) {
      this.deps.addSubscription(streamKey);
    }
    this.handlerCounts.set(streamKey, currentCount + 1);

    // Register on the router
    const routerCleanup = this.deps.router.on(streamKey, handler);

    // Track for bulk cleanup
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;

      // Remove from router
      routerCleanup();

      // Decrement handler count
      const count = this.handlerCounts.get(streamKey) ?? 0;
      const newCount = count - 1;
      if (newCount <= 0) {
        this.handlerCounts.delete(streamKey);
        this.deps.removeSubscription(streamKey);
      } else {
        this.handlerCounts.set(streamKey, newCount);
      }
    };

    this.cleanups.push(cleanup);
    return cleanup;
  }
}
