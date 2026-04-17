import type { AppSettings, AppConfig, AppSetting, Capabilities, ExtendedStreamType } from "../../types";
import { MentraSession } from "../MentraSession";
import { _V2AudioStreamShim } from "./_V2AudioStreamShim";
import { _V2CameraShim, type _V2PhotoRequestBridge } from "./_V2CameraShim";
import { _V2EventManagerShim } from "./_V2EventManagerShim";
import { _V2SettingsShim } from "./_V2SettingsShim";

/**
 * V2 Session Shim
 *
 * Wraps a v3 MentraSession in the v2 AppSession-shaped API so that
 * existing mini apps continue to work without code changes.
 *
 * This is the primary backward-compatibility surface. It exposes:
 *   - session.layouts.*      → delegates to session.display
 *   - session.audio.*        → delegates to session.speaker
 *   - session.simpleStorage  → delegates to session.storage
 *   - session.camera.*       → delegates via _V2CameraShim
 *   - session.events.*       → delegates via _V2EventManagerShim
 *   - session.settings.*     → delegates via _V2SettingsShim
 *   - All deprecated top-level on*() convenience methods
 *   - All v2 utility methods (getSettings, getWifiStatus, subscribe, etc.)
 *
 * Removed in v3.1.
 *
 * @internal
 */
export class _V2SessionShim {
  readonly session: MentraSession;

  // ─── V2 Module Surfaces ─────────────────────────────────────────────────

  readonly layouts: {
    showText: MentraSession["display"]["showText"];
    showTextWall: MentraSession["display"]["showTextWall"];
    showDoubleTextWall: MentraSession["display"]["showDoubleTextWall"];
    showReferenceCard: MentraSession["display"]["showReferenceCard"];
    showDashboardCard: MentraSession["display"]["showDashboardCard"];
    showBitmap: MentraSession["display"]["showBitmap"];
    clear: MentraSession["display"]["clear"];
    updateText: (payload: { text: string }) => void;
  };
  readonly simpleStorage: MentraSession["storage"];
  readonly audio: {
    speak: MentraSession["speaker"]["speak"];
    playAudio: (options: {
      url: string;
      volume?: number;
      trackId?: 0 | 1 | 2;
      stopOtherAudio?: boolean;
    }) => Promise<any>;
    stopAudio: (trackId?: 0 | 1 | 2) => Promise<void>;
    createOutputStream: (options?: Record<string, any>) => Promise<_V2AudioStreamShim>;
  };
  readonly camera: _V2CameraShim;
  readonly led: MentraSession["led"];
  readonly location: MentraSession["location"];
  readonly device: MentraSession["device"];
  readonly dashboard: MentraSession["dashboard"];
  readonly settings: _V2SettingsShim;
  readonly events: _V2EventManagerShim;

  constructor(
    session: MentraSession,
    options?: {
      photoRequestBridge?: _V2PhotoRequestBridge;
    },
  ) {
    this.session = session;
    this.layouts = {
      showText: session.display.showText.bind(session.display),
      showTextWall: session.display.showTextWall.bind(session.display),
      showDoubleTextWall: session.display.showDoubleTextWall.bind(session.display),
      showReferenceCard: session.display.showReferenceCard.bind(session.display),
      showDashboardCard: session.display.showDashboardCard.bind(session.display),
      showBitmap: session.display.showBitmap.bind(session.display),
      clear: session.display.clear.bind(session.display),
      updateText: ({ text }) => session.display.showTextWall(text),
    };
    this.simpleStorage = session.storage;
    this.audio = {
      speak: session.speaker.speak.bind(session.speaker),
      playAudio: (options) =>
        session.speaker.play({
          url: options.url,
          volume: options.volume,
          trackId: options.trackId,
          stopOtherAudio: options.stopOtherAudio,
        }),
      stopAudio: (trackId) => session.speaker.stop(trackId),
      createOutputStream: async (options?: Record<string, any>) =>
        new _V2AudioStreamShim(await session.speaker.createStream(options)),
    };
    this.camera = new _V2CameraShim(session, {
      photoRequestBridge: options?.photoRequestBridge,
      getV2Session: () => this,
    });
    this.led = session.led;
    this.location = session.location;
    this.device = session.device;
    this.dashboard = session.dashboard;
    this.settings = new _V2SettingsShim(session);
    this.events = new _V2EventManagerShim(session);
  }

  // ─── Identity ───────────────────────────────────────────────────────────

  get userId(): string | undefined {
    return this.session.userId;
  }

  get packageName(): string {
    return this.session.packageName;
  }

  getSessionId(): string {
    return this.session.sessionId;
  }

  getPackageName(): string {
    return this.session.packageName;
  }

  // ─── Capabilities ───────────────────────────────────────────────────────

  get capabilities(): Capabilities | null {
    return this.session.capabilities;
  }

  // ─── Settings Utility Methods ───────────────────────────────────────────

  /** @deprecated Use session.settings or session.settingsData */
  getSettings(): AppSettings {
    return this.session.settingsData;
  }

  /** @deprecated Use session.settings.get(key) */
  getSetting<T>(key: string): T | undefined {
    return this.settings.get<T>(key);
  }

  /** @deprecated Use session.appConfig */
  getConfig(): AppConfig | null {
    return this.session.appConfig;
  }

  /** @deprecated Use session.getServerUrl() */
  getServerUrl(): string | null {
    return this.session.getServerUrl();
  }

  /** @deprecated Convert WS URL to HTTPS */
  getHttpsServerUrl(): string | null {
    const serverUrl = this.session.getServerUrl();
    if (!serverUrl) return null;
    // Remove ws:// or wss://
    let url = serverUrl.replace(/^wss?:\/\//, "");
    // Remove trailing /app-ws
    url = url.replace(/\/app-ws$/, "");
    return `https://${url}`;
  }

  // ─── WiFi ───────────────────────────────────────────────────────────────

  /** @deprecated Use session.device.state.wifiConnected */
  getWifiStatus(): { connected: boolean; ssid?: string | null } | null {
    return {
      connected: this.session.device.state.wifiConnected.value,
      ssid: this.session.device.state.wifiSsid.value,
    };
  }

  /** @deprecated Use session.device.state.wifiConnected.value */
  isWifiConnected(): boolean {
    return this.session.device.state.wifiConnected.value === true;
  }

  /** @deprecated Use session.device.requestWifiSetup() */
  requestWifiSetup(reason?: string): void {
    this.session.device.requestWifiSetup(reason);
  }

  // ─── Subscription Methods ───────────────────────────────────────────────

  /**
   * @deprecated Subscriptions are now derived from handler registrations.
   * Prefer using manager methods (e.g., session.transcription.on()) which
   * handle subscriptions automatically.
   */
  subscribe(sub: string | { stream: string; rate?: string }): void {
    const stream = typeof sub === "string" ? sub : sub.stream;
    // Delegate to the internal subscription manager via MentraSession.
    // This is a manual override — the developer is explicitly asking to subscribe.
    (this.session as any)._subscriptions?.add(stream);
  }

  /**
   * @deprecated Subscriptions are now derived from handler registrations.
   */
  unsubscribe(sub: string | { stream: string }): void {
    const stream = typeof sub === "string" ? sub : sub.stream;
    (this.session as any)._subscriptions?.remove(stream);
  }

  // ─── Generic Event Listener ─────────────────────────────────────────────

  /** @deprecated Use the specific manager methods instead. */
  on(event: string, handler: (data: any) => void): () => void {
    return this.events.on(event as any, handler);
  }

  // ─── Connection State ───────────────────────────────────────────────────

  /** @deprecated Use session.device.state.connected.onChange() */
  onGlassesConnectionState(handler: (state: any) => void): () => void {
    return this.session.device.state.connected.onChange((connected) => {
      handler({
        connected,
        modelName: this.session.device.state.modelName.value,
        wifi: {
          connected: this.session.device.state.wifiConnected.value,
          ssid: this.session.device.state.wifiSsid.value,
        },
      });
    });
  }

  // ─── Direct Event Handling (deprecated on* methods) ─────────────────────

  /** @deprecated Use session.transcription.on() */
  onTranscription(handler: (data: any) => void): () => void {
    return this.events.onTranscription(handler);
  }

  /** @deprecated Use session.transcription.forLanguage() */
  onTranscriptionForLanguage(language: string, handler: (data: any) => void): () => void {
    return this.events.onTranscriptionForLanguage(language, handler);
  }

  /** @deprecated Use session.translation.fromTo() */
  onTranslationForLanguage(source: string, target: string, handler: (data: any) => void): () => void {
    return this.session.translation.fromTo(source, target, handler);
  }

  /** @deprecated Use session.device.onHeadPosition() */
  onHeadPosition(handler: (data: any) => void): () => void {
    return this.events.onHeadPosition(handler);
  }

  /** @deprecated Use session.device.onButtonPress() */
  onButtonPress(handler: (data: any) => void): () => void {
    return this.events.onButtonPress(handler);
  }

  /** @deprecated Use session.device.onTouchEvent() */
  onTouchEvent(gestureOrHandler: string | ((data: any) => void), handler?: (data: any) => void): () => void {
    return this.events.onTouchEvent(gestureOrHandler, handler);
  }

  /** @deprecated Use session.phone.notifications.on() */
  onPhoneNotifications(handler: (data: any) => void): () => void {
    return this.events.onPhoneNotifications(handler);
  }

  /** @deprecated Use session.phone.notifications.onDismissed() */
  onPhoneNotificationDismissed(handler: (data: any) => void): () => void {
    return this.events.onPhoneNotificationDismissed(handler);
  }

  /** @deprecated Use session.device.onVpsCoordinates() */
  onVpsCoordinates(handler: (data: any) => void): () => void {
    return this.events.onVpsCoordinates(handler);
  }

  // ─── Low-Level Message Sending ──────────────────────────────────────────

  // ─── Settings-Based Subscriptions ───────────────────────────────────────

  /**
   * @deprecated Use v3 manager-based subscriptions instead.
   *
   * Configure automatic subscription updates when settings change.
   * The handler function receives the current settings and returns
   * the desired subscription list. When any of the `updateOnChange`
   * keys change, the handler is re-evaluated and subscriptions updated.
   */
  private _subscriptionSettingsHandler?: (settings: AppSettings) => ExtendedStreamType[];
  private _subscriptionUpdateTriggers: string[] = [];

  setSubscriptionSettings(options: {
    updateOnChange: string[];
    handler: (settings: AppSettings) => ExtendedStreamType[];
  }): void {
    this._subscriptionUpdateTriggers = options.updateOnChange;
    this._subscriptionSettingsHandler = options.handler;

    // If we already have settings, evaluate immediately
    if (this.session.settingsData.length > 0) {
      this._updateSubscriptionsFromSettings();
    }

    // Listen for settings changes to re-evaluate
    this.session.onSettings((settings) => {
      const shouldUpdate = this._subscriptionUpdateTriggers.some((key) => {
        return settings.some((s: any) => s.key === key);
      });
      if (shouldUpdate) {
        this._updateSubscriptionsFromSettings();
      }
    });
  }

  private _updateSubscriptionsFromSettings(): void {
    if (!this._subscriptionSettingsHandler) return;
    try {
      this._subscriptionSettingsHandler(this.session.settingsData);
      // Note: with Bug 007 fix, subscriptions are derived from handlers.
      // The handler should register event handlers that correspond to the
      // desired subscriptions. This call just triggers the re-evaluation.
    } catch (error) {
      this.session.logger.error(error, "Error updating subscriptions from settings");
    }
  }

  // ─── Config Loading ─────────────────────────────────────────────────────

  /**
   * @deprecated Use appConfig property directly.
   * Load app configuration from a JSON string.
   */
  loadConfigFromJson(jsonData: string): AppConfig {
    try {
      const parsed = JSON.parse(jsonData);
      // Basic validation
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid App configuration format");
      }
      this.session.appConfig = parsed as AppConfig;
      return parsed as AppConfig;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load App configuration: ${msg}`);
    }
  }

  /**
   * @deprecated Read from appConfig.settings directly.
   * Get default settings from the loaded app configuration.
   */
  getDefaultSettings(): AppSettings {
    if (!this.session.appConfig) {
      throw new Error("App configuration not loaded. Call loadConfigFromJson first.");
    }
    return (this.session.appConfig.settings || [])
      .filter((s: any) => s.type !== "group" && "key" in s)
      .map((s: any) => ({ ...s, value: s.defaultValue }));
  }

  /**
   * @deprecated Read from appConfig.settings directly.
   * Get the schema for a specific setting key.
   */
  getSettingSchema(key: string): AppSetting | undefined {
    if (!this.session.appConfig) return undefined;
    return (this.session.appConfig.settings || []).find(
      (s: any) => s.type !== "group" && "key" in s && s.key === key,
    ) as AppSetting | undefined;
  }

  // ─── Messaging ──────────────────────────────────────────────────────────

  /** Send an arbitrary JSON message over the WebSocket. */
  sendMessage(message: unknown): void {
    this.session.sendMessage(message);
  }

  /** Send binary data over the WebSocket (e.g., audio stream frames). */
  sendBinary(data: ArrayBuffer | Uint8Array): void {
    this.session.sendBinary(data);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async releaseOwnership(reason: "switching_clouds" | "clean_shutdown" | "user_logout"): Promise<void> {
    await this.session.releaseOwnership(reason);
  }

  async disconnect(_options?: {
    releaseOwnership?: boolean;
    reason?: "switching_clouds" | "clean_shutdown" | "user_logout";
  }): Promise<void> {
    if (_options?.releaseOwnership && _options.reason) {
      await this.releaseOwnership(_options.reason);
    }

    await this.session.disconnect();
  }

  updateSettingsForTesting(newSettings: AppSettings): void {
    this.session.updateSettingsForTesting(newSettings);
  }
}
