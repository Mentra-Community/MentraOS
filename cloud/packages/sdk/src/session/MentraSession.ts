import EventEmitter from "events";
import type { Logger } from "pino";
import { createLogger, type LoggerConfig } from "../logging/logger";
import type { AppConfig, AppSettings, Capabilities } from "../types";
import { AppToCloudMessageType, CloudToAppMessageType } from "../types/message-types";
import type { Transport } from "../transport/Transport";
import { CameraManager } from "./managers/CameraManager";
import { DashboardManager } from "./managers/DashboardManager";
import { DeviceManager } from "./managers/DeviceManager";
import { DisplayManager } from "./managers/DisplayManager";
import { LedManager } from "./managers/LedManager";
import { LocationManager } from "./managers/LocationManager";
import { MicManager } from "./managers/MicManager";
import { PermissionsManager } from "./managers/PermissionsManager";
import { PhoneManager } from "./managers/PhoneManager";
import { SpeakerManager } from "./managers/SpeakerManager";
import { StorageManager } from "./managers/StorageManager";
import { TimeUtils } from "./managers/TimeUtils";
import { TranscriptionManager } from "./managers/TranscriptionManager";
import { TranslationManager } from "./managers/TranslationManager";
import { _MessageRouter } from "./internal/_MessageRouter";
import { _ConnectionManager } from "./internal/_ConnectionManager";
import { _SubscriptionManager } from "./internal/_SubscriptionManager";

export interface MentraSessionConfig extends LoggerConfig {
  packageName: string;
  apiKey: string;
  sessionId: string;
  transport: Transport;
  userId?: string;
  serverUrl?: string;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  logger?: Logger;
}

type SessionEventMap = {
  connected: [AppSettings];
  disconnected: [{ code: number; reason: string; permanent: boolean }];
  error: [Error];
  stopped: [string];
  settings: [AppSettings];
  reconnected: [];
};

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_PARKED_TIMEOUT_MS = 30_000;
const SDK_VERSION = "3.0.0-hono.8";

export class MentraSession {
  readonly transport: Transport;
  readonly logger: Logger;

  readonly permissions: PermissionsManager;
  readonly transcription: TranscriptionManager;
  readonly translation: TranslationManager;
  readonly display: DisplayManager;
  readonly speaker: SpeakerManager;
  readonly mic: MicManager;
  readonly device: DeviceManager;
  readonly phone: PhoneManager;
  readonly camera: CameraManager;
  readonly led: LedManager;
  readonly location: LocationManager;
  readonly dashboard: DashboardManager;
  readonly storage: StorageManager;
  readonly time: TimeUtils;

  settingsData: AppSettings = [];
  mentraosSettings: Record<string, any> = {};
  appConfig: AppConfig | null = null;
  capabilities: Capabilities | null = null;
  private runtimeSessionId: string;
  private hasCompletedInitialConnect = false;

  private readonly config: Required<
    Pick<
      MentraSessionConfig,
      "packageName" | "apiKey" | "sessionId" | "autoReconnect" | "maxReconnectAttempts" | "reconnectDelay"
    >
  > &
    Pick<MentraSessionConfig, "userId" | "serverUrl">;
  private readonly lifecycle = new EventEmitter();
  private readonly cleanupTasks: Array<() => void | Promise<void>> = [];
  private readonly _router: _MessageRouter;
  private readonly _subscriptions: _SubscriptionManager;
  private readonly _lifecycleManager: _ConnectionManager;

  constructor(config: MentraSessionConfig) {
    this.transport = config.transport;
    this.runtimeSessionId = config.sessionId;
    this.config = {
      packageName: config.packageName,
      apiKey: config.apiKey,
      sessionId: config.sessionId,
      userId: config.userId,
      serverUrl: config.serverUrl,
      autoReconnect: config.autoReconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS,
      reconnectDelay: config.reconnectDelay ?? DEFAULT_RECONNECT_DELAY_MS,
    };

    this.logger =
      config.logger ??
      createLogger({
        logLevel: config.logLevel,
        verbose: config.verbose,
      }).child({
        packageName: this.config.packageName,
        sessionId: this.config.sessionId,
        service: "mentra-session",
      });

    // SDK internal logger — tagged with _sdk: true so the clean transport
    // filters it to warn+ in the terminal. BetterStack still gets everything.
    // Developer's session.logger (above) has no _sdk tag → always visible.
    const sdkLogger = this.logger.child({ _sdk: true });

    this._router = new _MessageRouter(sdkLogger);
    this._subscriptions = new _SubscriptionManager({
      logger: sdkLogger,
      isConnected: () => this.isConnected,
      sendMessage: this.sendMessage.bind(this),
      getPackageName: () => this.config.packageName,
      getSessionId: () => this.runtimeSessionId,
    });
    this._lifecycleManager = new _ConnectionManager({
      transport: this.transport,
      logger: sdkLogger,
      autoReconnect: this.config.autoReconnect,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectDelay: this.config.reconnectDelay,
      onTransportReady: () => this.sendHandshake(),
      onTextMessage: (raw) => this.handleTextMessage(raw),
      onBinaryMessage: (data) => this.mic.handleBinaryAudio(data),
      onClose: (info) => this.emit("disconnected", info),
      onError: (error) => {
        this.emit("error", error);
        this.logger.error(error, "MentraSession transport error");
      },
    });

    this.permissions = new PermissionsManager({ logger: sdkLogger, messageHandlers: this._router.messageHandlers });

    const deps = {
      router: this._router.dataStreamRouter,
      messageHandlers: this._router.messageHandlers,
      addSubscription: (stream: string) => this._subscriptions.add(stream),
      removeSubscription: (stream: string) => this._subscriptions.remove(stream),
      sendMessage: this.sendMessage.bind(this),
      sendBinary: this.sendBinary.bind(this),
      logger: sdkLogger,
      getPackageName: () => this.config.packageName,
      getSessionId: () => this.runtimeSessionId,
      getServerUrl: () => this.getServerUrl(),
      permissions: this.permissions,
    };

    this.transcription = new TranscriptionManager(deps);
    this.translation = new TranslationManager(deps);
    this.display = new DisplayManager(deps);
    this.speaker = new SpeakerManager(deps);
    this.mic = new MicManager(deps);
    this.device = new DeviceManager(deps);
    this.phone = new PhoneManager(deps);
    this.camera = new CameraManager(deps);
    this.led = new LedManager(deps);
    this.location = new LocationManager(deps);
    this.dashboard = new DashboardManager(deps);
    this.storage = new StorageManager(deps, {
      userId: this.config.userId ?? "unknown-user",
      apiKey: this.config.apiKey,
    });
    this.time = new TimeUtils("UTC");

    this.registerCoreHandlers();
  }

  get packageName(): string {
    return this.config.packageName;
  }

  get sessionId(): string {
    return this.runtimeSessionId;
  }

  get userId(): string | undefined {
    return this.config.userId;
  }

  get isConnected(): boolean {
    return this._lifecycleManager.isConnected;
  }

  get isParked(): boolean {
    return this._lifecycleManager.isParked;
  }

  async connect(): Promise<void> {
    await this._lifecycleManager.connect();
  }

  async disconnect(): Promise<void> {
    this._lifecycleManager.disconnect();
    await this.destroyManagers();
    this._router.destroy();
    this._subscriptions.clear();
  }

  async releaseOwnership(reason: "switching_clouds" | "clean_shutdown" | "user_logout"): Promise<void> {
    this.sendMessage({
      type: AppToCloudMessageType.OWNERSHIP_RELEASE,
      packageName: this.config.packageName,
      sessionId: this.runtimeSessionId,
      reason,
      timestamp: new Date(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  updateSettingsForTesting(newSettings: AppSettings): void {
    this.settingsData = newSettings;
    this.permissions.updateFromSettings(newSettings);
    this.emit("settings", this.settingsData);
  }

  onConnected(handler: (...args: SessionEventMap["connected"]) => void): () => void {
    this.lifecycle.on("connected", handler);
    return () => this.lifecycle.off("connected", handler);
  }

  onDisconnected(handler: (...args: SessionEventMap["disconnected"]) => void): () => void {
    this.lifecycle.on("disconnected", handler);
    return () => this.lifecycle.off("disconnected", handler);
  }

  onError(handler: (...args: SessionEventMap["error"]) => void): () => void {
    this.lifecycle.on("error", handler);
    return () => this.lifecycle.off("error", handler);
  }

  onStopped(handler: (...args: SessionEventMap["stopped"]) => void): () => void {
    this.lifecycle.on("stopped", handler);
    return () => this.lifecycle.off("stopped", handler);
  }

  onSettings(handler: (...args: SessionEventMap["settings"]) => void): () => void {
    this.lifecycle.on("settings", handler);
    return () => this.lifecycle.off("settings", handler);
  }

  onReconnected(handler: (...args: SessionEventMap["reconnected"]) => void): () => void {
    this.lifecycle.on("reconnected", handler);
    return () => this.lifecycle.off("reconnected", handler);
  }

  sendMessage(message: unknown): void {
    this.transport.send(JSON.stringify(message));
  }

  sendBinary(data: ArrayBuffer | Uint8Array): void {
    this.transport.sendBinary(data);
  }

  getServerUrl(): string | null {
    return this.config.serverUrl ?? null;
  }

  private registerCoreHandlers(): void {
    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.DATA_STREAM, (message) => {
        this._router.dataStreamRouter.handle(message);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.CONNECTION_ACK, (message) => {
        this.handleConnectionAck(message, false);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.RECONNECT_ACK, (message) => {
        this.handleConnectionAck(message, true);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.SETTINGS_UPDATE, (message) => {
        this.handleSettingsUpdate(message);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.CAPABILITIES_UPDATE, (message) => {
        this.capabilities = message.capabilities ?? null;
        this.device.handleCapabilitiesUpdate(message);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.DEVICE_STATE_UPDATE, (message) => {
        this.device.handleDeviceStateUpdate(message);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.APP_STOPPED, (message) => {
        const reason = message.reason ?? "unknown";
        this.logger.info({ reason }, "MentraSession received app_stopped");

        // Tell _ConnectionManager NOT to reconnect. The cloud explicitly stopped
        // this session (user closed the app from the phone). Without this, the
        // subsequent WebSocket close triggers scheduleReconnect() because
        // explicitDisconnect is false (the SDK didn't initiate the close).
        // See: cloud/issues/088 — "app keeps restarting after user stops it"
        this._lifecycleManager.disconnect();

        this.emit("stopped", reason);
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.CONNECTION_ERROR, (message) => {
        this.emit("error", new Error(message.message ?? "MentraSession connection error"));
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.RECONNECT_REJECTED, (message) => {
        if (message.code === "NOT_RUNNING" || message.code === "BOOT_TIMEOUT") {
          this.transport.close(1000, message.message ?? "Reconnect rejected");
          this.emit("disconnected", {
            code: 4002,
            reason: message.message ?? "Reconnect rejected",
            permanent: true,
          });
          return;
        }

        this.sendConnectionInit();
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register(CloudToAppMessageType.RECONNECT_DEFERRED, (message) => {
        const timeoutMs = typeof message.timeoutMs === "number" ? message.timeoutMs : DEFAULT_PARKED_TIMEOUT_MS;
        this._lifecycleManager.park(timeoutMs, () => {
          this.transport.close(1000, "Parked timeout");
          this.emit("disconnected", {
            code: 4001,
            reason: "Parked reconnect timeout exceeded",
            permanent: true,
          });
        });
      }),
    );

    this.cleanupTasks.push(
      this._router.messageHandlers.register("augmentos_settings_update", (message) => {
        this.applyMentraosSettings(message.settings ?? {});
      }),
    );
  }

  private handleTextMessage(raw: string): void {
    try {
      this._router.handleRawText(raw);
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleConnectionAck(message: any, isReconnect: boolean): void {
    this.settingsData = message.settings ?? [];
    this.appConfig = message.config ?? null;
    this.capabilities = message.capabilities ?? null;
    this.runtimeSessionId = message.sessionId ?? this.runtimeSessionId;

    this.permissions.updateFromSettings(message.mentraosSettings ?? message.settings ?? {});
    this.applyMentraosSettings(message.mentraosSettings ?? {});

    if (message.capabilities) {
      this.device.handleCapabilitiesUpdate({
        type: CloudToAppMessageType.CAPABILITIES_UPDATE,
        capabilities: message.capabilities,
        modelName: message.capabilities.modelName ?? null,
      });
    }

    this._lifecycleManager.markConnected();
    this._subscriptions.sync();
    const wasReconnect = isReconnect || this.hasCompletedInitialConnect;
    this.hasCompletedInitialConnect = true;

    const transcriptionConfig = this.transcription.config;
    if (transcriptionConfig) {
      this.transcription.configure(transcriptionConfig);
    }

    this.emit("connected", this.settingsData);
    this.emit("settings", this.settingsData);
    if (wasReconnect) {
      this.emit("reconnected");
    }
  }

  private handleSettingsUpdate(message: any): void {
    this.settingsData = message.settings ?? [];
    this.permissions.updateFromSettings(message.settings ?? {});
    this.emit("settings", this.settingsData);
  }

  private applyMentraosSettings(settings: Record<string, any>): void {
    this.mentraosSettings = settings;
    const timezone = settings?.timezone;

    if (typeof timezone === "string" && timezone.length > 0) {
      try {
        this.time.setTimezone(timezone);
      } catch (error) {
        this.logger.warn({ timezone, error }, "MentraSession received invalid timezone");
      }
    }
  }

  private sendHandshake(): void {
    if (this.hasCompletedInitialConnect) {
      this.sendMessage({
        type: AppToCloudMessageType.RECONNECT,
        sessionId: this.runtimeSessionId,
        sdkVersion: SDK_VERSION,
        timestamp: new Date(),
      });
      return;
    }

    this.sendConnectionInit();
  }

  private sendConnectionInit(): void {
    this.sendMessage({
      type: AppToCloudMessageType.CONNECTION_INIT,
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      sdkVersion: SDK_VERSION,
      timestamp: new Date(),
    });
  }

  private emit<K extends keyof SessionEventMap>(event: K, ...args: SessionEventMap[K]): void {
    this.lifecycle.emit(event, ...args);
  }

  private async destroyManagers(): Promise<void> {
    this._lifecycleManager.destroy();

    await this.storage.destroy();
    this.camera.destroy();
    this.dashboard.destroy();
    this.device.destroy();
    this.led.destroy();
    this.location.destroy();
    this.mic.stop();
    this.phone.destroy();
    this.speaker.destroy();
    this.transcription.stop();
    this.translation.stop();

    for (const cleanup of this.cleanupTasks.splice(0)) {
      await cleanup();
    }
  }
}
