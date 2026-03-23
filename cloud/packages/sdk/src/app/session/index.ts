/**
 * 🎯 App Session Module
 *
 * Manages an active Third Party App session with MentraOS Cloud.
 * Handles real-time communication, event subscriptions, and display management.
 */

// Patch version for tracking Bug 007 fix (subscriptions derived from handlers)
// v1: Derive subscriptions from handlers (single source of truth)
// v2: Add 'terminated' flag to prevent reconnection after "User session ended"
// This helps verify the correct SDK version is running in production
const SDK_SUBSCRIPTION_PATCH = "bug007-fix-v2";
import pino from "pino";
import { WebSocket } from "ws";
import { EventManager, EventData } from "./events";
import { LayoutManager } from "./layouts";
import { SettingsManager } from "./settings";
import { LocationManager } from "./modules/location";
import { CameraModule } from "./modules/camera";
import { LedModule } from "./modules/led";
import { AudioManager } from "./modules/audio";
import { ResourceTracker } from "../../utils/resource-tracker";
import { MentraAuthError, MentraConnectionError, MentraTimeoutError, MentraError } from "../../logging/errors";
import { createTelemetryStream } from "../../logging/telemetry-transport";
import type { TelemetryLogEntry } from "../../types/messages/app-to-cloud";
import type { RequestWifiSetup, OwnershipReleaseMessage } from "../../types/messages/app-to-cloud";
import {
  // Message types
  AppToCloudMessage,
  CloudToAppMessage,
  AppConnectionInit,
  AppSubscriptionUpdate,
  AudioPlayResponse,
  AppToCloudMessageType,
  CloudToAppMessageType,
  TelemetryResponse,

  // Event data types
  StreamType,
  ExtendedStreamType,
  ButtonPress,
  HeadPosition,
  TouchEvent,
  PhoneNotification,
  PhoneNotificationDismissed,
  TranscriptionData,
  TranslationData,
  createTouchEventStream,

  // Type guards
  isAppConnectionAck,
  isAppConnectionError,
  isDataStream,
  isAppStopped,
  isSettingsUpdate,
  isDashboardModeChanged,
  isDashboardAlwaysOnChanged,
  isAudioPlayResponse,
  isCapabilitiesUpdate,

  // Other types
  AppSettings,
  AppSetting,
  AppConfig,
  validateAppConfig,
  AudioChunk,
  VpsCoordinates,
  PhotoTaken,
  SubscriptionRequest,
  Capabilities,
  CapabilitiesUpdate,
} from "../../types";
import { DashboardAPI } from "../../types/dashboard";
import { MentraosSettingsUpdate } from "../../types/messages/cloud-to-app";
import { Logger } from "pino";
import { AppServer } from "../server";
import axios from "axios";
import EventEmitter from "events";

// Import the cloud-to-app specific type guards
import {
  isPhotoResponse,
  isRgbLedControlResponse,
  isRtmpStreamStatus,
  isManagedStreamStatus,
  isStreamStatusCheckResponse,
  isDeviceStateUpdate,
  isRequestTelemetry,
} from "../../types/messages/cloud-to-app";
import type { RequestTelemetry } from "../../types/messages/cloud-to-app";
import type { PhotoResponse } from "../../types/messages/glasses-to-cloud";
import { SimpleStorage } from "./modules/simple-storage";
import { DeviceState } from "./device-state";
import { readNotificationWarnLog } from "../../utils/permissions-utils";

/**
 * ⚙️ Configuration options for App Session
 *
 * @example
 * ```typescript
 * const config: AppSessionConfig = {
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key',
 *   // Auto-reconnection is enabled by default
 *   // autoReconnect: true
 * };
 * ```
 */
export interface AppSessionConfig {
  /** 📦 Unique identifier for your App (e.g., 'org.company.appname') */
  packageName: string;
  /** 🔑 API key for authentication with MentraOS Cloud */
  apiKey: string;
  /** 🔌 WebSocket server URL (default: 'ws://localhost:7002/app-ws') */
  mentraOSWebsocketUrl?: string;
  /** 🔄 Automatically attempt to reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** 🔁 Maximum number of reconnection attempts (default: 3) */
  maxReconnectAttempts?: number;
  /** ⏱️ Base delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number;

  userId: string; // user ID for tracking sessions (email of the user).
  appServer: AppServer; // Optional App server instance for advanced features
}

// List of event types that should never be subscribed to as streams
const APP_TO_APP_EVENT_TYPES = [
  "app_message_received",
  "app_user_joined",
  "app_user_left",
  "app_room_updated",
  "app_direct_message_response",
];

/**
 * 🚀 App Session Implementation
 *
 * Manages a live connection between your App and MentraOS Cloud.
 * Provides interfaces for:
 * - 🎮 Event handling (transcription, head position, etc.)
 * - 📱 Display management in AR view
 * - 🔌 Connection lifecycle
 * - 🔄 Automatic reconnection
 *
 * @example
 * ```typescript
 * const session = new AppSession({
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key'
 * });
 *
 * // Handle events
 * session.onTranscription((data) => {
 *   session.layouts.showTextWall(data.text);
 * });
 *
 * // Connect to cloud
 * await session.connect('session_123');
 * ```
 */
export class AppSession {
  /** WebSocket connection to MentraOS Cloud */
  private ws: WebSocket | null = null;
  /** Current session identifier */
  private sessionId: string | null = null;
  /** Number of reconnection attempts made */
  private reconnectAttempts = 0;
  /** Flag to prevent reconnection after session termination (e.g., "User session ended") */
  private terminated = false;
  // REMOVED: private subscriptions = new Set<ExtendedStreamType>()
  // Subscriptions are now derived from EventManager.handlers (single source of truth)
  // This prevents drift between handlers and subscriptions that caused Bug 007
  // See: cloud/issues/006-captions-and-apps-stopping/011-sdk-subscription-architecture-mismatch.md
  /** Map to store rate options for streams */
  private streamRates = new Map<ExtendedStreamType, string>();
  /** Resource tracker for automatic cleanup */
  private resources = new ResourceTracker();
  /** Internal settings storage - use public settings API instead */
  private settingsData: AppSettings = [];
  /** App configuration loaded from app_config.json */
  private appConfig: AppConfig | null = null;
  /** Whether to update subscriptions when settings change */
  private shouldUpdateSubscriptionsOnSettingsChange = false;
  /** Custom subscription handler for settings-based subscriptions */
  private subscriptionSettingsHandler?: (settings: AppSettings) => ExtendedStreamType[];
  /** Settings that should trigger subscription updates when changed */
  private subscriptionUpdateTriggers: string[] = [];
  /** Pending user discovery requests waiting for responses */
  private pendingUserDiscoveryRequests = new Map<
    string,
    {
      resolve: (userList: any) => void;
      reject: (reason: any) => void;
    }
  >();
  /** Pending direct message requests waiting for responses */
  private pendingDirectMessages = new Map<
    string,
    {
      resolve: (success: boolean) => void;
      reject: (reason: any) => void;
    }
  >();

  /** 🎮 Event management interface */
  public readonly events: EventManager;
  /** 📱 Layout management interface */
  public readonly layouts: LayoutManager;
  /** ⚙️ Settings management interface */
  public readonly settings: SettingsManager;
  /** 📊 Dashboard management interface */
  public readonly dashboard: DashboardAPI;
  /** 📍 Location management interface */
  public readonly location: LocationManager;
  /** 📷 Camera interface for photos and streaming */
  public readonly camera: CameraModule;
  /** 💡 LED interface for RGB LED control */
  public readonly led: LedModule;
  /** 🔊 Audio interface for audio playback */
  public readonly audio: AudioManager;
  /** 🔐 Simple key-value storage interface */
  public readonly simpleStorage: SimpleStorage;
  /** 📱 Reactive device state (WebSocket-based observables) */
  public readonly device: { state: DeviceState };

  public readonly appServer: AppServer;
  public readonly logger: Logger;
  public readonly userId: string;

  /** 🔧 Device capabilities available for this session */
  public capabilities: Capabilities | null = null;

  /** 📡 Latest glasses connection state (includes WiFi status) */
  private glassesConnectionState: any = null; // Using any for now since GlassesConnectionState is in glasses-to-cloud types

  /** Dedicated emitter for App-to-App events */
  private appEvents = new EventEmitter();

  /**
   * Pending handlers waiting for AUDIO_STREAM_READY responses from the cloud.
   * Key: streamId, Value: handler function that receives the raw message.
   * Used by AudioOutputStream.waitForReady() to resolve the relay URL.
   * @internal
   */
  public _audioStreamReadyHandlers = new Map<string, (msg: any) => void>();

  /** Per-session ring buffer of recent log entries for incident telemetry uploads */
  private telemetryBuffer: TelemetryLogEntry[] = [];
  /** Interval that sends app-level pings to keep the app-ws connection alive.
   * Bidirectional traffic (ping → cloud, pong ← cloud) prevents load balancer
   * idle timeouts from killing the WebSocket. See: cloud/issues/046-sdk-app-ws-liveness */
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly PING_INTERVAL_MS = 15_000;

  constructor(private config: AppSessionConfig) {
    // Set defaults and merge with provided config
    this.config = {
      mentraOSWebsocketUrl: `ws://localhost:8002/app-ws`, // Use localhost as default
      autoReconnect: true, // Enable auto-reconnection by default for better reliability
      maxReconnectAttempts: 3, // Default to 3 reconnection attempts for better resilience
      reconnectDelay: 1000, // Start with 1 second delay (uses exponential backoff)
      ...config,
    };

    this.appServer = this.config.appServer;
    this.userId = this.config.userId;

    // Build session logger: child of appServer.logger (for BetterStack + console)
    // PLUS a telemetry stream that captures info+ entries into this session's
    // ring buffer. Because pino child loggers share the parent transport, we
    // instead create a fresh pino instance that:
    //   1. Forwards all writes to the parent (preserving BetterStack + console)
    //   2. Also tees into the per-session telemetry buffer
    // This means every session.logger.info/warn/error call — including all
    // module child loggers — is automatically captured for incident debugging.
    const parentLogger = this.appServer.logger.child({
      userId: this.config.userId,
      service: "app-session",
    });
    const telemetryStream = createTelemetryStream(this.telemetryBuffer, 500);
    // pino multistream: parent at debug (so BetterStack/console still control their own levels)
    // + telemetry stream at info (debug is too noisy for incident bundles)
    this.logger = pino(
      { level: "debug", base: null },
      pino.multistream([
        { stream: (parentLogger as any)[pino.symbols.streamSym] ?? process.stderr, level: "debug" },
        { stream: telemetryStream, level: "info" },
      ]),
    );

    // Make sure the URL is correctly formatted to prevent double protocol issues
    if (this.config.mentraOSWebsocketUrl) {
      try {
        const url = new URL(this.config.mentraOSWebsocketUrl);
        if (!["ws:", "wss:"].includes(url.protocol)) {
          // Fix URLs with incorrect protocol (e.g., 'ws://http://host')
          const fixedUrl = this.config.mentraOSWebsocketUrl.replace(/^ws:\/\/http:\/\//, "ws://");
          this.config.mentraOSWebsocketUrl = fixedUrl;
          this.logger.warn(`Fixed malformed WebSocket URL: ${fixedUrl}`);
        }
      } catch (error) {
        this.logger.error(error, `Invalid WebSocket URL format: ${this.config.mentraOSWebsocketUrl}`);
      }
    }

    this.logger.debug("App session initialized");

    // Validate URL format - give early warning for obvious issues
    // Check URL format but handle undefined case
    if (this.config.mentraOSWebsocketUrl) {
      try {
        const url = new URL(this.config.mentraOSWebsocketUrl);
        if (!["ws:", "wss:"].includes(url.protocol)) {
          this.logger.error(
            { config: this.config },
            `Invalid WebSocket URL protocol: ${url.protocol}. Should be ws: or wss:`,
          );
        }
      } catch (error) {
        this.logger.error(
          error,
          `⚠️ [${this.config.packageName}] Invalid WebSocket URL format: ${this.config.mentraOSWebsocketUrl}`,
        );
      }
    }

    this.events = new EventManager(
      this.subscribe.bind(this),
      this.unsubscribe.bind(this),
      this.config.packageName,
      this.getHttpsServerUrl() || "",
      this.logger,
    );
    this.layouts = new LayoutManager(config.packageName, this.send.bind(this));

    // Initialize settings manager with all necessary parameters, including subscribeFn for MentraOS settings
    this.settings = new SettingsManager(
      this.settingsData,
      this.config.packageName,
      this.config.mentraOSWebsocketUrl,
      this.sessionId ?? undefined,
      async (streams: string[]) => {
        // NOTE: With Bug 007 fix, subscriptions are derived from EventManager.handlers
        // This subscribeFn is called by SettingsManager to auto-subscribe to streams for MentraOS settings
        // The actual subscription intent should be tracked via handlers, not a separate Set
        this.logger.debug({ streams: JSON.stringify(streams) }, `[AppSession] subscribeFn called for streams`);

        // Log current handler-based subscriptions for debugging
        const currentHandlerStreams = this.events.getRegisteredStreams();
        this.logger.debug(
          {
            requestedStreams: JSON.stringify(streams),
            currentHandlerStreams: JSON.stringify(currentHandlerStreams),
          },
          `[AppSession] subscribeFn: requested streams vs current handler streams`,
        );

        // Send subscription update if connected
        // Note: The actual subscriptions sent are derived from handlers
        if (this.ws?.readyState === 1) {
          this.updateSubscriptions();
          this.logger.debug(`[AppSession] Sent updated subscriptions to cloud (derived from handlers).`);
        } else {
          this.logger.debug(`[AppSession] WebSocket not open, will send subscriptions when connected.`);
        }
      },
    );

    // Initialize dashboard API with this session instance
    // Import DashboardManager dynamically to avoid circular dependency
    const { DashboardManager } = require("./dashboard");
    this.dashboard = new DashboardManager(this);

    // Initialize camera module with session reference
    this.camera = new CameraModule(
      this,
      this.config.packageName,
      this.sessionId || "unknown-session-id",
      this.logger.child({ module: "camera" }),
    );

    // Initialize LED control module
    this.led = new LedModule(
      this,
      this.config.packageName,
      this.sessionId || "unknown-session-id",
      this.logger.child({ module: "led" }),
    );

    // Initialize audio module with session reference
    this.audio = new AudioManager(
      this,
      this.config.packageName,
      this.sessionId || "unknown-session-id",
      this.logger.child({ module: "audio" }),
    );

    this.simpleStorage = new SimpleStorage(this);
    this.device = { state: new DeviceState(this) };

    this.location = new LocationManager(this);
  }

  /**
   * Get the current session ID
   * @returns The current session ID or 'unknown-session-id' if not connected
   */
  getSessionId(): string {
    return this.sessionId || "unknown-session-id";
  }

  /**
   * Get the package name for this App
   * @returns The package name
   */
  getPackageName(): string {
    return this.config.packageName;
  }

  // =====================================
  // 🎮 Direct Event Handling Interface
  // =====================================

  /**
   * @deprecated Use session.events.onTranscription() instead
   */
  onTranscription(handler: (data: TranscriptionData) => void): () => void {
    return this.events.onTranscription(handler);
  }

  /**
   * 🌐 Listen for speech transcription events in a specific language
   * @param language - Language code (e.g., "en-US")
   * @param handler - Function to handle transcription data
   * @returns Cleanup function to remove the handler
   * @throws Error if language code is invalid
   * @deprecated Use session.events.onTranscriptionForLanguage() instead
   */
  onTranscriptionForLanguage(
    language: string,
    handler: (data: TranscriptionData) => void,
    disableLanguageIdentification = false,
  ): () => void {
    return this.events.onTranscriptionForLanguage(language, handler, disableLanguageIdentification);
  }

  /**
   * 🌐 Listen for speech translation events for a specific language pair
   * @param sourceLanguage - Source language code (e.g., "es-ES")
   * @param targetLanguage - Target language code (e.g., "en-US")
   * @param handler - Function to handle translation data
   * @returns Cleanup function to remove the handler
   * @throws Error if language codes are invalid
   * @deprecated Use session.events.onTranslationForLanguage() instead
   */
  onTranslationForLanguage(
    sourceLanguage: string,
    targetLanguage: string,
    handler: (data: TranslationData) => void,
  ): () => void {
    return this.events.ontranslationForLanguage(sourceLanguage, targetLanguage, handler);
  }

  /**
   * 👤 Listen for head position changes
   * @param handler - Function to handle head position updates
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onHeadPosition() instead
   */
  onHeadPosition(handler: (data: HeadPosition) => void): () => void {
    return this.events.onHeadPosition(handler);
  }

  /**
   * 🔘 Listen for hardware button press events
   * @param handler - Function to handle button events
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onButtonPress() instead
   */
  onButtonPress(handler: (data: ButtonPress) => void): () => void {
    return this.events.onButtonPress(handler);
  }

  /**
   * 👆 Listen for touch gesture events
   * @param gestureOrHandler - Gesture name or handler function
   * @param handler - Handler function (if first param is gesture name)
   * @returns Cleanup function
   *
   * @example
   * // Subscribe to all touch events
   * session.onTouchEvent((event) => console.log(event.gesture_name));
   *
   * // Subscribe to specific gesture
   * session.onTouchEvent("forward_swipe", (event) => console.log("Forward swipe!"));
   */
  onTouchEvent(
    gestureOrHandler: string | ((data: TouchEvent) => void),
    handler?: (data: TouchEvent) => void,
  ): () => void {
    return this.events.onTouchEvent(gestureOrHandler as any, handler as any);
  }

  /**
   * 👆 Subscribe to multiple touch gestures
   * @param gestures - Array of gesture names
   * @returns Cleanup function that unsubscribes from all
   *
   * @example
   * session.subscribeToGestures(["forward_swipe", "backward_swipe"]);
   */
  subscribeToGestures(gestures: string[]): () => void {
    gestures.forEach((gesture) => {
      const stream = createTouchEventStream(gesture);
      this.subscribe(stream);
    });

    return () => {
      gestures.forEach((gesture) => {
        const stream = createTouchEventStream(gesture);
        this.unsubscribe(stream);
      });
    };
  }

  /**
   * 📱 Listen for phone notification events
   * @param handler - Function to handle notifications
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onPhoneNotifications() instead
   */
  onPhoneNotifications(handler: (data: PhoneNotification) => void): () => void {
    readNotificationWarnLog(this.getHttpsServerUrl() || "", this.getPackageName(), "onPhoneNotifications");
    return this.events.onPhoneNotifications(handler);
  }

  /**
   * 📱 Listen for phone notification dismissed events
   * @param handler - Function to handle notification dismissal data
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onPhoneNotificationDismissed() instead
   */
  onPhoneNotificationDismissed(handler: (data: PhoneNotificationDismissed) => void): () => void {
    return this.events.onPhoneNotificationDismissed(handler);
  }

  /**
   * 📡 Listen for VPS coordinates updates
   * @param handler - Function to handle VPS coordinates
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onVpsCoordinates() instead
   */
  onVpsCoordinates(handler: (data: VpsCoordinates) => void): () => void {
    this.subscribe(StreamType.VPS_COORDINATES);
    return this.events.onVpsCoordinates(handler);
  }

  /**
   * 📸 Listen for photo responses
   * @param handler - Function to handle photo response data
   * @returns Cleanup function to remove the handler
   * @deprecated Use session.events.onPhotoTaken() instead
   */
  onPhotoTaken(handler: (data: PhotoTaken) => void): () => void {
    this.subscribe(StreamType.PHOTO_TAKEN);
    return this.events.onPhotoTaken(handler);
  }

  // =====================================
  // 📡 Pub/Sub Interface
  // =====================================

  /**
   * 📬 Subscribe to a specific event stream
   * @param sub - A string or a rich subscription object
   */
  subscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType;
    let rate: string | undefined;

    if (typeof sub === "string") {
      type = sub;
    } else {
      // it's a LocationStreamRequest object
      type = sub.stream;
      rate = sub.rate;
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to subscribe to App-to-App event type '${type}', which is not a valid stream. Use the event handler (e.g., onAppMessage) instead.`,
      );
      return;
    }

    // NOTE: We no longer maintain this.subscriptions - subscriptions are derived from handlers
    // This prevents drift between handlers and subscriptions (Bug 007 fix)
    // The EventManager.addHandler() already tracks the subscription intent via handlers

    if (rate) {
      this.streamRates.set(type, rate);
    }

    if (this.ws?.readyState === 1) {
      this.updateSubscriptions();
    }
  }

  /**
   * 📭 Unsubscribe from a specific event stream
   * @param sub - The subscription to remove
   */
  unsubscribe(sub: SubscriptionRequest): void {
    let type: ExtendedStreamType;
    if (typeof sub === "string") {
      type = sub;
    } else {
      type = sub.stream;
    }

    if (APP_TO_APP_EVENT_TYPES.includes(type as string)) {
      this.logger.warn(
        `[AppSession] Attempted to unsubscribe from App-to-App event type '${type}', which is not a valid stream.`,
      );
      return;
    }
    // NOTE: We no longer maintain this.subscriptions - subscriptions are derived from handlers
    // The EventManager.removeHandler() already tracks the unsubscription intent

    this.streamRates.delete(type); // also remove from our rate map
    if (this.ws?.readyState === 1) {
      this.updateSubscriptions();
    }
  }

  /**
   * 🎯 Generic event listener (pub/sub style)
   * @param event - Event name to listen for
   * @param handler - Event handler function
   */
  on<T extends ExtendedStreamType>(event: T, handler: (data: EventData<T>) => void): () => void {
    return this.events.on(event, handler);
  }

  // =====================================
  // 🔌 Connection Management
  // =====================================

  /**
   * 🚀 Connect to MentraOS Cloud
   * @param sessionId - Unique session identifier
   * @returns Promise that resolves when connected
   */
  async connect(sessionId: string): Promise<void> {
    this.sessionId = sessionId;

    // Configure settings API client with the WebSocket URL and session ID
    // This allows settings to be fetched from the correct server
    this.settings.configureApiClient(this.config.packageName, this.config.mentraOSWebsocketUrl || "", sessionId);

    // Update the sessionId in the camera module
    if (this.camera) {
      this.camera.updateSessionId(sessionId);
    }

    // Update the sessionId in the audio module
    if (this.audio) {
      this.audio.updateSessionId(sessionId);
    }

    return new Promise((resolve, reject) => {
      try {
        // Stop ping interval before replacing the WebSocket.
        // This prevents a stale interval from a previous connection running
        // during the reconnect window. startPingInterval() also calls this,
        // but clearing here means no pings fire on a dead socket at all.
        this.stopPingInterval();

        // Clear previous resources if reconnecting
        if (this.ws) {
          // Don't call full dispose() as that would clear subscriptions
          if (this.ws.readyState !== 3) {
            // 3 = CLOSED
            this.ws.close();
          }
          this.ws = null;
        }

        // Validate WebSocket URL before attempting connection
        if (!this.config.mentraOSWebsocketUrl) {
          this.logger.error("WebSocket URL is missing or undefined");
          reject(new MentraConnectionError("WebSocket URL is required"));
          return;
        }

        this.logger.debug(`Connecting to ${this.config.mentraOSWebsocketUrl}`);

        // Create connection with error handling
        this.ws = new WebSocket(this.config.mentraOSWebsocketUrl);

        // Track WebSocket for automatic cleanup
        this.resources.track(() => {
          if (this.ws && this.ws.readyState !== 3) {
            // 3 = CLOSED
            this.ws.close();
          }
        });

        this.ws.on("open", () => {
          try {
            this.sendConnectionInit();
          } catch (error: unknown) {
            this.logger.error(error, "Error during connection initialization");
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.events.emit("error", new MentraConnectionError(`Connection initialization failed: ${errorMessage}`));
            reject(error instanceof Error ? error : new MentraConnectionError(String(error)));
          }
        });

        // Message handler with comprehensive error recovery
        const messageHandler = async (data: Buffer | string, isBinary: boolean) => {
          try {
            // Handle binary messages (typically audio data)
            if (isBinary && Buffer.isBuffer(data)) {
              try {
                // Validate buffer before processing
                if (data.length === 0) {
                  this.events.emit("error", new MentraError("Received empty binary data", "EMPTY_DATA"));
                  return;
                }

                // Convert Node.js Buffer to ArrayBuffer safely
                const arrayBuf: ArrayBufferLike = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

                // Create AUDIO_CHUNK event message with validation
                const audioChunk: AudioChunk = {
                  type: StreamType.AUDIO_CHUNK,
                  arrayBuffer: arrayBuf,
                  timestamp: new Date(), // Ensure timestamp is present
                };

                this.handleMessage(audioChunk);
                return;
              } catch (error: unknown) {
                this.logger.error(error, "Error processing binary message:");
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.events.emit(
                  "error",
                  new MentraError(`Failed to process binary message: ${errorMessage}`, "PARSE_ERROR"),
                );
                return;
              }
            }

            // Handle ArrayBuffer data type directly
            if (data instanceof ArrayBuffer) {
              return;
            }

            // Handle JSON messages with validation
            try {
              // Convert string data to JSON safely
              let jsonData: string;
              if (typeof data === "string") {
                jsonData = data;
              } else if (Buffer.isBuffer(data)) {
                jsonData = data.toString("utf8");
              } else {
                throw new Error("Unknown message format");
              }

              // Validate JSON before parsing
              if (!jsonData || jsonData.trim() === "") {
                this.events.emit("error", new MentraError("Received empty JSON message", "PARSE_ERROR"));
                return;
              }

              // Parse JSON with error handling
              const message = JSON.parse(jsonData) as CloudToAppMessage;

              // Basic schema validation
              if (!message || typeof message !== "object" || !("type" in message)) {
                this.events.emit("error", new MentraError("Malformed message: missing type property", "PARSE_ERROR"));
                return;
              }

              // Process the validated message
              this.handleMessage(message);
            } catch (error: unknown) {
              this.logger.error(error, "JSON parsing error");
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.events.emit("error", new MentraError(`Failed to parse message: ${errorMessage}`, "PARSE_ERROR"));
            }
          } catch (error: unknown) {
            // Final catch - should never reach here if individual handlers work correctly
            this.logger.error({ error }, "Unhandled message processing error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.events.emit("error", new MentraError(`Unhandled message error: ${errorMessage}`, "INTERNAL_ERROR"));
          }
        };

        this.ws.on("message", messageHandler);

        // Track event handler removal for automatic cleanup
        this.resources.track(() => {
          if (this.ws) {
            this.ws.off("message", messageHandler);
          }
        });

        // Connection closure handler
        const closeHandler = (code: number, reason: string) => {
          const reasonStr = reason ? `: ${reason}` : "";
          const closeInfo = `Connection closed (code: ${code})${reasonStr}`;

          // Emit the disconnected event with structured data for better handling
          this.events.emit("disconnected", {
            message: closeInfo,
            code: code,
            reason: reason || "",
            wasClean: code === 1000 || code === 1001,
          });

          // Only attempt reconnection for abnormal closures
          // https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code
          // 1000 (Normal Closure) and 1001 (Going Away) are normal
          // 1002-1015 are abnormal, and reason "App stopped" means intentional closure
          // 1008 usually when the userSession no longer exists on server. i.e user disconnected from cloud.
          const isNormalClosure = code === 1000 || code === 1001 || code === 1008;
          const isManualStop = reason && reason.includes("App stopped");
          const isUserSessionEnded = reason && reason.includes("User session ended");

          this.logger.debug(`WebSocket closed (code: ${code}${reasonStr})`);

          // Stop ping interval immediately — the socket is closed so pings are pointless.
          // connect() will restart it on reconnect; disconnect() would also clear it,
          // but stopping here prevents an orphaned interval if neither is called.
          this.stopPingInterval();

          // If user session ended, mark as terminated to prevent any future reconnection
          if (isUserSessionEnded) {
            this.terminated = true;
            this.logger.debug("User session ended — marked as terminated, no reconnection");
          }

          if (!isNormalClosure && !isManualStop && !this.terminated) {
            this.logger.debug("Abnormal closure detected, attempting reconnection");
            this.handleReconnection();
          } else {
            this.logger.debug("Normal closure, not reconnecting");
          }

          // if user session ended, then trigger onStop.
          if (isUserSessionEnded) {
            this.logger.debug("User session ended — emitting disconnected event");
            // Emit a disconnected event with a special flag to indicate session end
            // This will be caught by AppServer which will call the onStop callback
            const disconnectInfo = {
              message: "User session ended",
              code: 1000, // Normal closure
              reason: "User session ended",
              wasClean: true,
              permanent: true, // This is permanent - no reconnection
              sessionEnded: true, // Special flag to indicate session disposal
            };
            this.events.emit("disconnected", disconnectInfo);
          }
        };

        this.ws.on("close", closeHandler);

        // Track event handler removal
        this.resources.track(() => {
          if (this.ws) {
            this.ws.off("close", closeHandler);
          }
        });

        // Connection error handler
        const errorHandler = (error: Error) => {
          this.logger.error(error, "WebSocket error");
          this.events.emit("error", new MentraConnectionError(error.message));
        };

        this.ws.on("error", (error: Error) => {
          errorHandler(error);
        });

        // Track event handler removal
        this.resources.track(() => {
          if (this.ws) {
            this.ws.off("error", errorHandler);
          }
        });

        // Set up connection success handler
        const connectedCleanup = this.events.onConnected(() => resolve());

        // Track event handler removal
        this.resources.track(connectedCleanup);

        // Connection timeout with configurable duration
        const timeoutMs = 5000; // 5 seconds default
        const connectionTimeout = this.resources.setTimeout(() => {
          // Use tracked timeout that will be auto-cleared
          this.logger.error(
            {
              config: this.config,
              sessionId: this.sessionId,
              timeoutMs,
            },
            `Connection timeout after ${timeoutMs}ms`,
          );

          const err = new MentraTimeoutError(`Connection timeout after ${timeoutMs}ms`);
          this.events.emit("error", err);
          reject(err);
        }, timeoutMs);

        // Clear timeout on successful connection
        const timeoutCleanup = this.events.onConnected(() => {
          clearTimeout(connectionTimeout);
          resolve();
        });

        // Track event handler removal
        this.resources.track(timeoutCleanup);
      } catch (error: unknown) {
        this.logger.error(error, "Connection setup error");
        const errorMessage = error instanceof Error ? error.message : String(error);
        reject(new MentraConnectionError(`Failed to setup connection: ${errorMessage}`));
      }
    });
  }

  /**
   * 🔄 Release ownership of this session to allow clean handoff
   * Call this before connecting to a different cloud instance or shutting down cleanly.
   * This signals to the cloud that no resurrection is needed.
   *
   * @param reason - Why ownership is being released
   */
  async releaseOwnership(reason: "switching_clouds" | "clean_shutdown" | "user_logout"): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.debug(`[${this.config.packageName}] Cannot release ownership - WebSocket not open`);
      return;
    }

    const message: OwnershipReleaseMessage = {
      type: AppToCloudMessageType.OWNERSHIP_RELEASE,
      packageName: this.config.packageName,
      sessionId: this.sessionId || "",
      reason,
      timestamp: new Date(),
    };

    this.logger.info(
      { reason, sessionId: this.sessionId },
      `🔄 [${this.config.packageName}] Releasing ownership: ${reason}`,
    );

    this.send(message);

    // Small delay to ensure message is sent before any subsequent disconnect
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * 👋 Disconnect from MentraOS Cloud
   * Flushes any pending SimpleStorage writes before closing
   *
   * @param options - Optional disconnect options
   * @param options.releaseOwnership - If true, send OWNERSHIP_RELEASE before disconnecting (enables clean handoff)
   * @param options.reason - Reason for ownership release (required if releaseOwnership is true)
   */
  async disconnect(options?: {
    releaseOwnership?: boolean;
    reason?: "switching_clouds" | "clean_shutdown" | "user_logout";
  }): Promise<void> {
    // Release ownership if requested (for clean handoffs)
    if (options?.releaseOwnership && options?.reason) {
      await this.releaseOwnership(options.reason);
    }

    // Flush any pending SimpleStorage writes before closing
    try {
      await this.simpleStorage.flush();
      console.log("SimpleStorage flushed on disconnect");
    } catch (error) {
      console.error("Error flushing SimpleStorage on disconnect:", error);
      // Continue with disconnect even if flush fails
    }

    // Clean up camera module first
    if (this.camera) {
      this.camera.cancelAllRequests();
    }

    // Clean up audio module
    if (this.audio) {
      this.audio.cancelAllRequests();
    }

    // Stop ping interval before disposing resources
    this.stopPingInterval();

    // Use the resource tracker to clean up everything
    this.resources.dispose();

    // Clean up additional resources not handled by the tracker
    this.ws = null;
    this.sessionId = null;
    // REMOVED: this.subscriptions.clear()
    // We no longer clear subscriptions here - they are derived from handlers
    // This is the key fix for Bug 007: clearing subscriptions here caused
    // empty subscription updates on reconnect when handlers still existed
    // See: cloud/issues/006-captions-and-apps-stopping/011-sdk-subscription-architecture-mismatch.md
    this.reconnectAttempts = 0;
  }

  /**
   * 🛠️ Get all current user settings
   * @returns A copy of the current settings array
   * @deprecated Use session.settings.getAll() instead
   */
  getSettings(): AppSettings {
    return this.settings.getAll();
  }

  /**
   * 🔍 Get a specific setting value by key
   * @param key The setting key to look for
   * @returns The setting's value, or undefined if not found
   * @deprecated Use session.settings.get(key) instead
   */
  getSetting<T>(key: string): T | undefined {
    return this.settings.get<T>(key);
  }

  /**
   * ⚙️ Configure settings-based subscription updates
   * This allows Apps to automatically update their subscriptions when certain settings change
   * @param options Configuration options for settings-based subscriptions
   */
  setSubscriptionSettings(options: {
    updateOnChange: string[]; // Setting keys that should trigger subscription updates
    handler: (settings: AppSettings) => ExtendedStreamType[]; // Handler that returns new subscriptions
  }): void {
    this.shouldUpdateSubscriptionsOnSettingsChange = true;
    this.subscriptionUpdateTriggers = options.updateOnChange;
    this.subscriptionSettingsHandler = options.handler;

    // If we already have settings, update subscriptions immediately
    if (this.settingsData.length > 0) {
      this.updateSubscriptionsFromSettings();
    }
  }

  /**
   * 🔄 Update subscriptions based on current settings
   * Called automatically when relevant settings change
   */
  private updateSubscriptionsFromSettings(): void {
    if (!this.subscriptionSettingsHandler) return;

    try {
      // Get desired subscriptions from settings handler
      const settingsSubscriptions = this.subscriptionSettingsHandler(this.settingsData);

      // NOTE: Settings-based subscriptions work differently from handler-based subscriptions
      // With the Bug 007 fix, subscriptions are now derived from EventManager.handlers
      // Apps using setSubscriptionSettings() should ensure their settings correspond to
      // registered handlers for the subscriptions to take effect.
      //
      // Log if there's a mismatch (for debugging during migration)
      const handlerStreams = this.events.getRegisteredStreams();
      if (settingsSubscriptions.length !== handlerStreams.length) {
        this.logger.warn(
          {
            settingsSubscriptions: JSON.stringify(settingsSubscriptions),
            handlerStreams: JSON.stringify(handlerStreams),
          },
          `[AppSession] Settings-based subscriptions (${settingsSubscriptions.length}) differ from handler-based subscriptions (${handlerStreams.length}). ` +
            `Subscriptions are now derived from handlers. Ensure handlers are registered for desired streams.`,
        );
      }

      // Send subscription update to cloud if connected
      // Note: updateSubscriptions() derives from handlers, so settings-based apps
      // should ensure their settings correspond to registered handlers
      if (this.ws && this.ws.readyState === 1) {
        this.updateSubscriptions();
      }
    } catch (error: unknown) {
      this.logger.error(error, "Error updating subscriptions from settings");
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit(
        "error",
        new MentraError(`Failed to update subscriptions: ${errorMessage}`, "SUBSCRIPTION_ERROR"),
      );
    }
  }

  /**
   * 🧪 For testing: Update settings locally
   * In normal operation, settings come from the cloud
   * @param newSettings The new settings to apply
   */
  updateSettingsForTesting(newSettings: AppSettings): void {
    this.settingsData = newSettings;

    // Update the settings manager with the new settings
    this.settings.updateSettings(newSettings);

    // Emit update event for backwards compatibility
    this.events.emit("settings_update", this.settingsData);

    // Check if we should update subscriptions
    if (this.shouldUpdateSubscriptionsOnSettingsChange) {
      this.updateSubscriptionsFromSettings();
    }
  }

  /**
   * 📝 Load configuration from a JSON file
   * @param jsonData JSON string containing App configuration
   * @returns The loaded configuration
   * @throws Error if the configuration is invalid
   */
  loadConfigFromJson(jsonData: string): AppConfig {
    try {
      const parsedConfig = JSON.parse(jsonData);

      if (validateAppConfig(parsedConfig)) {
        this.appConfig = parsedConfig;
        return parsedConfig;
      } else {
        throw new Error("Invalid App configuration format");
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load App configuration: ${errorMessage}`);
    }
  }

  /**
   * 📋 Get the loaded App configuration
   * @returns The current App configuration or null if not loaded
   */
  getConfig(): AppConfig | null {
    return this.appConfig;
  }

  /**
   * 🔌 Get the WebSocket server URL for this session
   * @returns The WebSocket server URL used by this session
   */
  getServerUrl(): string | undefined {
    return this.config.mentraOSWebsocketUrl;
  }

  public getHttpsServerUrl(): string | undefined {
    if (!this.config.mentraOSWebsocketUrl) {
      return undefined;
    }
    return AppSession.convertToHttps(this.config.mentraOSWebsocketUrl);
  }

  private static convertToHttps(rawUrl: string | undefined): string {
    if (!rawUrl) return "";
    // Remove ws:// or wss://
    let url = rawUrl.replace(/^wss?:\/\//, "");
    // Remove trailing /app-ws
    url = url.replace(/\/app-ws$/, "");
    // Prepend https://
    return `https://${url}`;
  }

  /**
   * 🔍 Get default settings from the App configuration
   * @returns Array of settings with default values
   * @throws Error if configuration is not loaded
   */
  getDefaultSettings(): AppSettings {
    if (!this.appConfig) {
      throw new Error("App configuration not loaded. Call loadConfigFromJson first.");
    }

    return this.appConfig.settings
      .filter((s: AppSetting | { type: "group"; title: string }): s is AppSetting => s.type !== "group")
      .map((s: AppSetting) => ({
        ...s,
        value: s.defaultValue, // Set value to defaultValue
      }));
  }

  /**
   * 🔍 Get setting schema from configuration
   * @param key Setting key to look up
   * @returns The setting schema or undefined if not found
   */
  getSettingSchema(key: string): AppSetting | undefined {
    if (!this.appConfig) return undefined;

    const setting = this.appConfig.settings.find(
      (s: AppSetting | { type: "group"; title: string }) => s.type !== "group" && "key" in s && s.key === key,
    );

    return setting as AppSetting | undefined;
  }

  /**
   * 📡 Get WiFi connection status of glasses
   * @returns WiFi status object or null if glasses don't support WiFi or status not available
   */
  getWifiStatus(): { connected: boolean; ssid?: string | null } | null {
    if (!this.capabilities?.hasWifi) {
      return null;
    }
    return this.glassesConnectionState?.wifi || null;
  }

  /**
   * ✅ Check if glasses are connected to WiFi
   * @returns true if connected to WiFi, false otherwise
   */
  isWifiConnected(): boolean {
    return this.getWifiStatus()?.connected === true;
  }

  /**
   * 🌐 Request WiFi setup from mobile app
   * Triggers a popup on the mobile app that allows user to set up WiFi on glasses
   * @param reason Optional reason message to display to the user
   */
  requestWifiSetup(reason?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to MentraOS Cloud");
    }

    const message: RequestWifiSetup = {
      type: AppToCloudMessageType.REQUEST_WIFI_SETUP,
      packageName: this.config.packageName,
      sessionId: this.sessionId || "",
      reason,
      timestamp: new Date(),
    };

    this.send(message);
  }

  /**
   * 👂 Listen for glasses connection state changes (includes WiFi status)
   * @param handler Callback function to handle connection state updates
   * @returns Cleanup function to remove the listener
   */
  onGlassesConnectionState(handler: (state: any) => void): () => void {
    return this.events.on(StreamType.GLASSES_CONNECTION_STATE, handler);
  }

  // =====================================
  // 🔧 Private Methods
  // =====================================

  /**
   * 📨 Handle incoming messages from cloud
   */
  private handleMessage(message: CloudToAppMessage): void {
    try {
      // Validate message before processing
      if (!this.validateMessage(message)) {
        this.events.emit("error", new MentraError("Invalid message format received", "PARSE_ERROR"));
        return;
      }

      // Handle binary data (audio or video)
      if (message instanceof ArrayBuffer) {
        this.handleBinaryMessage(message);
        return;
      }

      // Using type guards to determine message type and safely handle each case
      try {
        if (isAppConnectionAck(message)) {
          // Get settings from connection acknowledgment
          const receivedSettings = message.settings || [];
          this.settingsData = receivedSettings;

          // Store config if provided
          if (message.config && validateAppConfig(message.config)) {
            this.appConfig = message.config;
          }

          // Use default settings from config if no settings were provided
          if (receivedSettings.length === 0 && this.appConfig) {
            try {
              this.settingsData = this.getDefaultSettings();
            } catch (error) {
              this.logger.warn(error, "Failed to load default settings from config:");
            }
          }

          // Update the settings manager with the new settings
          this.settings.updateSettings(this.settingsData);

          // Handle MentraOS system settings if provided
          this.logger.debug(
            { mentraosSettings: JSON.stringify(message.mentraosSettings) },
            `[AppSession] CONNECTION_ACK mentraosSettings}`,
          );
          if (message.mentraosSettings) {
            this.logger.info(
              { mentraosSettings: JSON.stringify(message.mentraosSettings) },
              `[AppSession] Calling updatementraosSettings with`,
            );
            this.settings.updateMentraosSettings(message.mentraosSettings);
          } else {
            this.logger.warn(`[AppSession] CONNECTION_ACK message missing mentraosSettings field`);
          }

          // Handle device capabilities if provided
          if (message.capabilities) {
            this.capabilities = message.capabilities;
            this.logger.info(`[AppSession] Device capabilities loaded for model: ${message.capabilities.modelName}`);
          } else {
            this.logger.debug(`[AppSession] No capabilities provided in CONNECTION_ACK`);
          }

          // Emit connected event with settings
          this.events.emit("connected", this.settingsData);

          // Start app-level ping interval to keep the app-ws connection alive.
          // The SDK sends {type:"ping"} every 15s; the cloud responds {type:"pong"}.
          // Both directions produce traffic, satisfying infra bidirectional-traffic
          // requirements that prevent load balancer idle timeouts.
          // Only new-SDK apps send pings — old 2.x apps are unaffected.
          // See: cloud/issues/046-sdk-app-ws-liveness
          this.startPingInterval();

          // Log once to confirm Bug 007 fix is active (subscriptions derived from handlers)
          const handlerCount = this.events.getRegisteredStreams().length;
          this.logger.info(
            { patch: SDK_SUBSCRIPTION_PATCH, handlerCount },
            `[AppSession] 🔧 SDK Patch Active: ${SDK_SUBSCRIPTION_PATCH} - Subscriptions derived from ${handlerCount} handler(s)`,
          );

          // Update subscriptions (normal flow)
          this.updateSubscriptions();

          // If settings-based subscriptions are enabled, update those too
          if (this.shouldUpdateSubscriptionsOnSettingsChange && this.settingsData.length > 0) {
            this.updateSubscriptionsFromSettings();
          }
        } else if (isAppConnectionError(message) || message.type === "connection_error") {
          // Handle both App-specific connection_error and standard connection_error
          const errorMessage = message.message || "Unknown connection error";
          this.events.emit("error", new MentraAuthError(errorMessage));
        } else if (message.type === StreamType.AUDIO_CHUNK) {
          // Check if we have a handler registered for AUDIO_CHUNK (derived from handlers)
          const hasAudioHandler = this.events.getRegisteredStreams().includes(StreamType.AUDIO_CHUNK);
          if (hasAudioHandler) {
            // Only process if we're subscribed to avoid unnecessary processing
            this.events.emit(StreamType.AUDIO_CHUNK, message);
          }
        } else if (isDataStream(message) && message.streamType === StreamType.GLASSES_CONNECTION_STATE) {
          // Store latest glasses connection state (includes WiFi info)
          this.glassesConnectionState = message.data;

          // Emit to subscribed listeners (check derived from handlers)
          const hasGlassesStateHandler = this.events
            .getRegisteredStreams()
            .includes(StreamType.GLASSES_CONNECTION_STATE);
          if (hasGlassesStateHandler) {
            const sanitizedData = this.sanitizeEventData(
              StreamType.GLASSES_CONNECTION_STATE,
              message.data,
            ) as EventData<typeof StreamType.GLASSES_CONNECTION_STATE>;
            this.events.emit(StreamType.GLASSES_CONNECTION_STATE, sanitizedData);
          }
        } else if (isDataStream(message)) {
          // Ensure streamType exists before emitting the event
          const messageStreamType = message.streamType as ExtendedStreamType;
          // if (message.streamType === StreamType.TRANSCRIPTION) {
          //   const transcriptionData = message.data as TranscriptionData;
          //   if (transcriptionData.transcribeLanguage) {
          //     messageStreamType = createTranscriptionStream(transcriptionData.transcribeLanguage) as ExtendedStreamType;
          //   }
          // } else if (message.streamType === StreamType.TRANSLATION) {
          //   const translationData = message.data as TranslationData;
          //   if (translationData.transcribeLanguage && translationData.translateLanguage) {
          //     messageStreamType = createTranslationStream(translationData.transcribeLanguage, translationData.translateLanguage) as ExtendedStreamType;
          //   }
          // }

          // Check if we have a handler registered for this stream type (derived from handlers)
          const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType);
          if (messageStreamType && hasHandler) {
            const sanitizedData = this.sanitizeEventData(messageStreamType, message.data) as EventData<
              typeof messageStreamType
            >;
            this.events.emit(messageStreamType, sanitizedData);
          }
        } else if (isRtmpStreamStatus(message)) {
          // Emit as a standard stream event if subscribed (check derived from handlers)
          const hasRtmpHandler = this.events.getRegisteredStreams().includes(StreamType.RTMP_STREAM_STATUS);
          if (hasRtmpHandler) {
            this.events.emit(StreamType.RTMP_STREAM_STATUS, message);
          }

          // Update camera module's internal stream state
          this.camera.updateStreamState(message);
        } else if (isManagedStreamStatus(message)) {
          // Emit as a standard stream event if subscribed (check derived from handlers)
          const hasManagedStreamHandler = this.events.getRegisteredStreams().includes(StreamType.MANAGED_STREAM_STATUS);
          if (hasManagedStreamHandler) {
            this.events.emit(StreamType.MANAGED_STREAM_STATUS, message);
          }

          // Update camera module's managed stream state
          this.camera.handleManagedStreamStatus(message);
        } else if (isStreamStatusCheckResponse(message)) {
          // Handle stream status check response
          // This is a direct response, not a subscription-based event
          this.camera.handleStreamCheckResponse(message);
        } else if (isSettingsUpdate(message)) {
          // Store previous settings to check for changes
          const _prevSettings = [...this.settingsData];

          // Update internal settings storage
          this.settingsData = message.settings || [];

          // Update the settings manager with the new settings
          const changes = this.settings.updateSettings(this.settingsData);

          // Emit settings update event (for backwards compatibility)
          this.events.emit("settings_update", this.settingsData);

          // --- MentraOS settings update logic ---
          // If the message.settings looks like MentraOS settings (object with known keys), update mentraosSettings
          if (message.settings && typeof message.settings === "object") {
            this.settings.updateMentraosSettings(message.settings);
          }

          // Check if we should update subscriptions
          if (this.shouldUpdateSubscriptionsOnSettingsChange) {
            // Check if any subscription trigger settings changed
            const shouldUpdateSubs = this.subscriptionUpdateTriggers.some((key) => {
              return key in changes;
            });

            if (shouldUpdateSubs) {
              this.updateSubscriptionsFromSettings();
            }
          }
        } else if (isCapabilitiesUpdate(message)) {
          // Update device capabilities
          const capabilitiesMessage = message as CapabilitiesUpdate;
          this.capabilities = capabilitiesMessage.capabilities;
          this.logger.info(
            capabilitiesMessage.capabilities,
            `[AppSession] Capabilities updated for model: ${capabilitiesMessage.modelName}`,
          );

          // Emit capabilities update event for applications to handle
          this.events.emit("capabilities_update", {
            capabilities: capabilitiesMessage.capabilities,
            modelName: capabilitiesMessage.modelName,
            timestamp: capabilitiesMessage.timestamp,
          });
        } else if (isDeviceStateUpdate(message)) {
          // Update device state observables
          this.device.state.updateFromMessage(message.state);

          this.logger.debug(
            {
              changedFields: Object.keys(message.state),
              fullSnapshot: message.fullSnapshot,
            },
            `[AppSession] Device state updated via WebSocket`,
          );
        } else if (isAppStopped(message)) {
          const reason = message.reason || "unknown";
          const displayReason = `App stopped: ${reason}`;

          // Don't emit disconnected event here - let the WebSocket close handler do it
          // This prevents duplicate disconnected events when the session is disposed
          this.logger.info(`📤 [${this.config.packageName}] Received APP_STOPPED message: ${displayReason}`);

          // Clear reconnection state
          this.reconnectAttempts = 0;
        }
        // Handle dashboard mode changes
        else if (isDashboardModeChanged(message)) {
          try {
            // Use proper type
            const mode = message.mode || "none";

            // Update dashboard state in the API
            if (this.dashboard && "content" in this.dashboard) {
              (this.dashboard.content as any).setCurrentMode(mode);
            }
          } catch (error) {
            this.logger.error(error, "Error handling dashboard mode change");
          }
        }
        // Handle always-on dashboard state changes
        else if (isDashboardAlwaysOnChanged(message)) {
          try {
            // Use proper type
            const enabled = !!message.enabled;

            // Update dashboard state in the API
            if (this.dashboard && "content" in this.dashboard) {
              (this.dashboard.content as any).setAlwaysOnEnabled(enabled);
            }
          } catch (error) {
            this.logger.error(error, "Error handling dashboard always-on change");
          }
        }
        // Handle custom messages
        else if (message.type === CloudToAppMessageType.CUSTOM_MESSAGE) {
          this.events.emit("custom_message", message);
          return;
        }
        // Handle App-to-App communication messages
        else if ((message as any).type === "app_message_received") {
          this.appEvents.emit("app_message_received", message as any);
        } else if ((message as any).type === "app_user_joined") {
          this.appEvents.emit("app_user_joined", message as any);
        } else if ((message as any).type === "app_user_left") {
          this.appEvents.emit("app_user_left", message as any);
        } else if ((message as any).type === "app_room_updated") {
          this.appEvents.emit("app_room_updated", message as any);
        } else if ((message as any).type === "app_direct_message_response") {
          const response = message as any;
          if (response.messageId && this.pendingDirectMessages.has(response.messageId)) {
            const { resolve } = this.pendingDirectMessages.get(response.messageId)!;
            resolve(response.success);
            this.pendingDirectMessages.delete(response.messageId);
          }
        } else if (message.type === "augmentos_settings_update") {
          const mentraosMsg = message as MentraosSettingsUpdate;
          if (mentraosMsg.settings && typeof mentraosMsg.settings === "object") {
            this.settings.updateMentraosSettings(mentraosMsg.settings);
          }
        }
        // Handle 'connection_error' as a specific case if cloud sends this string literal
        else if ((message as any).type === "connection_error") {
          // Treat 'connection_error' (string literal) like AppConnectionError
          // This handles cases where the cloud might send the type as a direct string
          // instead of the enum's 'tpa_connection_error' value.
          const errorMessage = (message as any).message || "Unknown connection error (type: connection_error)";
          this.logger.warn(
            `Received 'connection_error' type directly. Consider aligning cloud to send 'tpa_connection_error'. Message: ${errorMessage}`,
          );
          this.events.emit("error", new MentraConnectionError(errorMessage));
        } else if (message.type === "permission_error") {
          // Handle permission errors from cloud
          this.logger.warn(
            {
              message: message.message,
              details: message.details,
              detailsCount: message.details?.length || 0,
              rejectedStreams: message.details?.map((d) => d.stream) || [],
            },
            "Permission error received:",
          );

          // Emit permission error event for application handling
          this.events.emit("permission_error", {
            message: message.message,
            details: message.details,
            timestamp: message.timestamp,
          });

          // Optionally emit individual permission denied events for each stream
          message.details?.forEach((detail) => {
            this.events.emit("permission_denied", {
              stream: detail.stream,
              requiredPermission: detail.requiredPermission,
              message: detail.message,
            });
          });
        } else if (message.type === "audio_stream_ready") {
          // Route AUDIO_STREAM_READY to the pending handler for this streamId
          const streamId = (message as any).streamId;
          const handler = this._audioStreamReadyHandlers.get(streamId);
          if (handler) {
            handler(message);
            this._audioStreamReadyHandlers.delete(streamId);
          } else {
            this.logger.debug({ streamId }, "Received audio_stream_ready with no pending handler");
          }
        } else if (isAudioPlayResponse(message)) {
          // Delegate audio play response handling to the audio module
          if (this.audio) {
            this.audio.handleAudioPlayResponse(message as AudioPlayResponse);
          }
        } else if (isPhotoResponse(message)) {
          // Photo responses can arrive via WebSocket when the cloud forwards error/success
          // from the phone's REST endpoint (POST /api/client/photo/response).
          // Success photos normally arrive via HTTP to /photo-upload, but errors always
          // come through WebSocket because the phone reports them to cloud, not directly
          // to the SDK. We MUST handle errors here to reject the pending promise immediately
          // instead of letting the developer wait 30s for a generic timeout.
          // See: OS-947, OS-951
          const photoResponse = message as PhotoResponse;
          const { requestId, success } = photoResponse;

          if (requestId && this.appServer) {
            const pending = this.appServer.completePhotoRequest(requestId);
            if (pending) {
              if (success) {
                // Success via WebSocket (legacy path — normally comes via /photo-upload HTTP)
                this.logger.info({ requestId }, "📸 Photo success received via WebSocket (legacy path)");
                pending.resolve({
                  buffer: Buffer.from([]),
                  mimeType: "image/jpeg",
                  filename: "photo.jpg",
                  requestId,
                  size: 0,
                  timestamp: new Date(),
                  photoUrl: photoResponse.photoUrl,
                } as any);
              } else {
                // Error response — this is the critical path for OS-947/OS-951
                const errorCode = photoResponse.error?.code || "UNKNOWN_ERROR";
                const errorMessage = photoResponse.error?.message || "Photo capture failed";
                this.logger.warn(
                  { requestId, errorCode, errorMessage },
                  `📸 Photo error received via WebSocket: ${errorCode} - ${errorMessage}`,
                );
                pending.reject(new Error(`${errorCode}: ${errorMessage}`));
              }
            } else {
              this.logger.debug(
                { requestId, success },
                "Photo response received via WebSocket but no pending request found (may have timed out or been completed via /photo-upload)",
              );
            }
          } else {
            this.logger.warn(
              { requestId, hasAppServer: !!this.appServer },
              "Photo response received via WebSocket but missing requestId or appServer",
            );
          }
        } else if (isRgbLedControlResponse(message)) {
          // LED control responses are no longer handled - fire-and-forget mode
          this.logger.debug({ message }, "Received LED control response (ignored - fire-and-forget mode)");
        } else if (isRequestTelemetry(message)) {
          // Cloud is asking us to upload recent telemetry logs for incident debugging
          this.handleTelemetryRequest(message as RequestTelemetry).catch((err) => {
            this.logger.warn(err, "handleTelemetryRequest failed");
          });
        } else if ((message as any).type === "pong") {
          // Cloud responded to our app-level ping — bidirectional traffic maintained.
          // No action needed: the response itself satisfies the egress requirement.
          // See: cloud/issues/046-sdk-app-ws-liveness
        }
        // Handle unrecognized message types gracefully
        else {
          this.logger.warn(`Unrecognized message type: ${(message as any).type}`);
          this.events.emit(
            "error",
            new MentraError(`Unrecognized message type: ${(message as any).type}`, "UNKNOWN_TYPE"),
          );
        }
      } catch (processingError: unknown) {
        // Catch any errors during message processing to prevent App crashes
        this.logger.error(processingError, "Error processing message:");
        const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
        this.events.emit("error", new MentraError(`Error processing message: ${errorMessage}`, "INTERNAL_ERROR"));
      }
    } catch (error: unknown) {
      // Final safety net to ensure the App doesn't crash on any unexpected errors
      this.logger.error(error, "Unexpected error in message handler");
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit("error", new Error(`Unexpected error in message handler: ${errorMessage}`));
    }
  }

  /**
   * 🏓 Start the app-level ping interval.
   * Clears any existing interval first so reconnects don't double-up.
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // If send fails the WebSocket is already dead; the close handler
        // will fire and trigger reconnection — nothing to do here.
      }
    }, AppSession.PING_INTERVAL_MS);
  }

  /**
   * 🏓 Stop the app-level ping interval.
   */
  private stopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * 📤 Handle a REQUEST_TELEMETRY message from cloud.
   * Collects recent log entries from the AppServer's telemetry buffer and
   * POSTs them back to the cloud's incident endpoint so the support team
   * can diagnose production issues.
   *
   * @param request - The REQUEST_TELEMETRY message from cloud
   */
  private async handleTelemetryRequest(request: RequestTelemetry): Promise<void> {
    const { incidentId, uploadToken, windowMs } = request;

    // Read from this session's own buffer — already scoped to this user
    const cutoff = windowMs ? Date.now() - windowMs : 0;
    const logs = cutoff > 0 ? this.telemetryBuffer.filter((e) => e.timestamp >= cutoff) : [...this.telemetryBuffer];

    this.logger.debug({ incidentId, logCount: logs.length, windowMs }, "Collecting telemetry for incident upload");

    const payload: TelemetryResponse = {
      type: AppToCloudMessageType.TELEMETRY_RESPONSE,
      incidentId,
      packageName: this.config.packageName,
      logs,
      metadata: {
        bufferSize: logs.length,
        oldestEntryMs: logs.length > 0 ? logs[0].timestamp : undefined,
        newestEntryMs: logs.length > 0 ? logs[logs.length - 1].timestamp : undefined,
      },
    };

    const baseUrl = this.getHttpsServerUrl();
    if (!baseUrl) {
      this.logger.warn({ incidentId }, "Cannot upload telemetry — no server URL available");
      return;
    }

    try {
      // Strip any path suffix (e.g. /app-ws) to get the cloud root URL
      const cloudBase = baseUrl.replace(/\/app-ws.*$/, "");
      const url = `${cloudBase}/api/incidents/${incidentId}/logs`;

      await axios.post(url, payload, {
        headers: {
          "Authorization": `Bearer ${uploadToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      });

      this.logger.info({ incidentId, logCount: logs.length }, "Telemetry uploaded successfully");
    } catch (err) {
      this.logger.error(err, `Failed to upload telemetry for incident ${incidentId}`);
    }
  }

  /**
   * 🧪 Validate incoming message structure
   * @param message - Message to validate
   * @returns boolean indicating if the message is valid
   */
  private validateMessage(message: CloudToAppMessage): boolean {
    // Handle ArrayBuffer case separately
    if (message instanceof ArrayBuffer) {
      return true; // ArrayBuffers are always considered valid at this level
    }

    // Check if message is null or undefined
    if (!message) {
      return false;
    }

    // Check if message has a type property
    if (!("type" in message)) {
      return false;
    }

    // All other message types should be objects with a type property
    return true;
  }

  /**
   * 📦 Handle binary message data (audio or video)
   * @param buffer - Binary data as ArrayBuffer
   */
  private handleBinaryMessage(buffer: ArrayBuffer): void {
    try {
      // Safety check - only process if we have a handler registered (derived from handlers)
      const hasAudioHandler = this.events.getRegisteredStreams().includes(StreamType.AUDIO_CHUNK);
      if (!hasAudioHandler) {
        return;
      }

      // Validate buffer has content before processing
      if (!buffer || buffer.byteLength === 0) {
        this.events.emit("error", new Error("Received empty binary message"));
        return;
      }

      // Create a safety wrapped audio chunk with proper defaults
      const audioChunk: AudioChunk = {
        type: StreamType.AUDIO_CHUNK,
        timestamp: new Date(),
        arrayBuffer: buffer,
        sampleRate: 16000, // Default sample rate
      };

      // Emit to subscribers
      this.events.emit(StreamType.AUDIO_CHUNK, audioChunk);
    } catch (error: unknown) {
      this.logger.error(error, "Error processing binary message");
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit("error", new Error(`Error processing binary message: ${errorMessage}`));
    }
  }

  /**
   * 🧹 Sanitize event data to prevent crashes from malformed data
   * @param streamType - The type of stream data
   * @param data - The potentially unsafe data to sanitize
   * @returns Sanitized data safe for processing
   */
  private sanitizeEventData(streamType: ExtendedStreamType, data: unknown): any {
    try {
      // If data is null or undefined, return an empty object to prevent crashes
      if (data === null || data === undefined) {
        return {};
      }

      // For specific stream types, perform targeted sanitization
      switch (streamType) {
        case StreamType.TRANSCRIPTION: {
          // Ensure text field exists and is a string
          if (typeof (data as TranscriptionData).text !== "string") {
            return {
              text: "",
              isFinal: true,
              startTime: Date.now(),
              endTime: Date.now(),
            };
          }
          break;
        }

        case StreamType.HEAD_POSITION: {
          // Ensure position data has required numeric fields
          // Handle HeadPosition - Note the property position instead of x,y,z
          const pos = data as any;
          if (typeof pos?.position !== "string") {
            return { position: "up", timestamp: new Date() };
          }
          break;
        }

        case StreamType.BUTTON_PRESS: {
          // Ensure button type is valid
          const btn = data as any;
          if (!btn.buttonId || !btn.pressType) {
            return {
              buttonId: "unknown",
              pressType: "short",
              timestamp: new Date(),
            };
          }
          break;
        }
      }

      return data;
    } catch (error: unknown) {
      this.logger.error(error, `Error sanitizing ${streamType} data`);
      // Return a safe empty object if something goes wrong
      return {};
    }
  }

  /**
   * 🔐 Send connection initialization message
   */
  private sendConnectionInit(): void {
    const message: AppConnectionInit = {
      type: AppToCloudMessageType.CONNECTION_INIT,
      sessionId: this.sessionId!,
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      timestamp: new Date(),
    };
    this.send(message);
  }

  /**
   * 📝 Update subscription list with cloud
   */
  private updateSubscriptions(): void {
    // CRITICAL FIX (Bug 007): Derive subscriptions from EventManager.handlers
    // This ensures subscriptions can NEVER be empty if handlers exist
    // Previously, this.subscriptions could drift out of sync with handlers
    // See: cloud/issues/006-captions-and-apps-stopping/011-sdk-subscription-architecture-mismatch.md
    const derivedSubscriptions = this.events.getRegisteredStreams();

    this.logger.info(
      { subscriptions: JSON.stringify(derivedSubscriptions) },
      `[AppSession] updateSubscriptions: sending ${derivedSubscriptions.length} subscriptions to cloud (derived from handlers)`,
    );

    // Build the array of SubscriptionRequest objects to send to the cloud
    const subscriptionPayload: SubscriptionRequest[] = derivedSubscriptions.map((stream) => {
      const rate = this.streamRates.get(stream);
      if (rate && stream === StreamType.LOCATION_STREAM) {
        return { stream: "location_stream", rate: rate as any };
      }
      return stream;
    });

    const message: AppSubscriptionUpdate = {
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      packageName: this.config.packageName,
      subscriptions: subscriptionPayload,
      sessionId: this.sessionId!,
      timestamp: new Date(),
    };
    this.send(message);
  }

  /**
   * 🔄 Handle reconnection with exponential backoff
   */
  private async handleReconnection(): Promise<void> {
    // Check if session was terminated (e.g., "User session ended")
    if (this.terminated) {
      this.logger.info(
        `🔄 Reconnection skipped: session was terminated (User session ended). ` +
          `If cloud restarts app, onSession will be called with fresh handlers.`,
      );
      return;
    }

    // Check if reconnection is allowed
    if (!this.config.autoReconnect || !this.sessionId) {
      this.logger.debug(
        `🔄 Reconnection skipped: autoReconnect=${this.config.autoReconnect}, sessionId=${
          this.sessionId ? "valid" : "invalid"
        }`,
      );
      return;
    }

    // Check if we've exceeded the maximum attempts
    const maxAttempts = this.config.maxReconnectAttempts || 3;
    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.warn(`Reconnection failed after ${maxAttempts} attempts, giving up`);

      // Emit a permanent disconnection event to trigger onStop in the App server
      this.events.emit("disconnected", {
        message: `Connection permanently lost after ${maxAttempts} failed reconnection attempts`,
        code: 4000, // Custom code for max reconnection attempts exhausted
        reason: "Maximum reconnection attempts exceeded",
        wasClean: false,
        permanent: true, // Flag this as a permanent disconnection
      });

      return;
    }

    // Calculate delay with exponential backoff
    const baseDelay = this.config.reconnectDelay || 1000;
    const delay = baseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.logger.warn(`Connection lost, reconnecting (${this.reconnectAttempts}/${maxAttempts})...`);

    // Use the resource tracker for the timeout
    await new Promise<void>((resolve) => {
      this.resources.setTimeout(() => resolve(), delay);
    });

    try {
      await this.connect(this.sessionId);
      this.logger.info("Reconnected successfully");
      this.reconnectAttempts = 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(error, "Reconnection attempt failed");
      this.events.emit("error", new Error(`Reconnection failed: ${errorMessage}`));

      // Check if this was the last attempt
      if (this.reconnectAttempts >= maxAttempts) {
        this.logger.debug("Final reconnection attempt failed, emitting permanent disconnection");

        // Emit permanent disconnection event after the last failed attempt
        this.events.emit("disconnected", {
          message: `Connection permanently lost after ${maxAttempts} failed reconnection attempts`,
          code: 4000, // Custom code for max reconnection attempts exhausted
          reason: "Maximum reconnection attempts exceeded",
          wasClean: false,
          permanent: true, // Flag this as a permanent disconnection
        });
      }
    }
  }

  /**
   * 📤 Public API for modules to send messages
   * Always uses current WebSocket connection
   */
  public sendMessage(message: AppToCloudMessage): void {
    return this.send(message);
  }

  /**
   * 📤 Send raw binary data over the WebSocket.
   * Used by AudioOutputStream to push audio frames to the cloud relay.
   *
   * Binary frame format for audio streaming:
   *   [36 bytes: streamId UUID as ASCII] [N bytes: audio data]
   *
   * @param data - Binary data to send
   * @throws {Error} If WebSocket is not connected
   * @internal
   */
  public sendBinary(data: Uint8Array | Buffer): void {
    if (!this.ws) {
      throw new Error("WebSocket connection not established");
    }
    if (this.ws.readyState !== 1) {
      throw new Error("WebSocket not connected");
    }
    try {
      this.ws.send(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.debug({ err }, "Failed to send binary frame");
      throw new Error(`Failed to send binary data: ${errorMessage}`);
    }
  }

  /**
   * 📤 Send message to cloud with validation and error handling
   * @throws {Error} If WebSocket is not connected
   */
  private send(message: AppToCloudMessage): void {
    try {
      // Verify WebSocket connection is valid
      if (!this.ws) {
        throw new Error("WebSocket connection not established");
      }

      if (this.ws.readyState !== 1) {
        const stateMap: Record<number, string> = {
          0: "CONNECTING",
          1: "OPEN",
          2: "CLOSING",
          3: "CLOSED",
        };
        const stateName = stateMap[this.ws.readyState] || "UNKNOWN";
        throw new Error(`WebSocket not connected (current state: ${stateName})`);
      }

      // Validate message before sending
      if (!message || typeof message !== "object") {
        throw new Error("Invalid message: must be an object");
      }

      if (!("type" in message)) {
        throw new Error('Invalid message: missing "type" property');
      }

      // Ensure message format is consistent
      if (!("timestamp" in message) || !(message.timestamp instanceof Date)) {
        message.timestamp = new Date();
      }

      // Try to send with error handling
      try {
        const serializedMessage = JSON.stringify(message);
        this.ws.send(serializedMessage);
      } catch (sendError: unknown) {
        const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
        throw new Error(`Failed to send message: ${errorMessage}`);
      }
    } catch (error: unknown) {
      // Check if this is an expected disconnection error (not a real error)
      const isDisconnectError =
        error instanceof Error &&
        (error.message.includes("WebSocket not connected") ||
          error.message.includes("CLOSED") ||
          error.message.includes("CLOSING"));

      if (isDisconnectError) {
        // Don't log as error - this is expected when user disconnects
        // Apps should handle this gracefully by checking session.isConnected
        this.logger.debug(error, "Message send skipped - session disconnected");
      } else {
        // This is an actual error that needs attention
        this.logger.error(error, "Message send error");
      }

      // Ensure we always emit an Error object
      if (error instanceof Error) {
        this.events.emit("error", error);
      } else {
        this.events.emit("error", new Error(String(error)));
      }

      // Re-throw to maintain the original function behavior
      throw error;
    }
  }

  /**
   * Fetch the onboarding instructions for this session from the backend.
   * @returns Promise resolving to the instructions string or null
   */
  public async getInstructions(): Promise<string | null> {
    try {
      const baseUrl = this.getServerUrl();
      const response = await axios.get(`${baseUrl}/api/instructions`, {
        params: { userId: this.userId },
      });
      return response.data.instructions || null;
    } catch (err) {
      this.logger.error(err, `Error fetching instructions from backend`);
      return null;
    }
  }
  // =====================================
  // 👥 App-to-App Communication Interface
  // =====================================

  /**
   * 👥 Discover other users currently using the same App
   * @param includeProfiles - Whether to include user profile information
   * @returns Promise that resolves with list of active users
   */
  async discoverAppUsers(domain: string, includeProfiles = false): Promise<any> {
    // Use the domain argument as the base URL if provided
    if (!domain) {
      throw new Error("Domain (API base URL) is required for user discovery");
    }
    const url = `${domain}/api/app-communication/discover-users`;
    // Use the user's core token for authentication
    const appApiKey = this.config.apiKey; // This may need to be updated if you store the core token elsewhere

    if (!appApiKey) {
      throw new Error("Core token (apiKey) is required for user discovery");
    }
    const body = {
      packageName: this.config.packageName,
      userId: this.userId,
      includeUserProfiles: includeProfiles,
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${appApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to discover users: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return await response.json();
  }

  /**
   * 🔍 Check if a specific user is currently active
   * @param userId - User ID to check for
   * @returns Promise that resolves with boolean indicating if user is active
   */
  async isUserActive(userId: string): Promise<boolean> {
    try {
      const userList = await this.discoverAppUsers("", false);
      return userList.users.some((user: any) => user.userId === userId);
    } catch (error) {
      this.logger.error({ error, userId }, "Error checking if user is active");
      return false;
    }
  }

  /**
   * 📊 Get user count for this App
   * @returns Promise that resolves with number of active users
   */
  async getUserCount(domain: string): Promise<number> {
    try {
      const userList = await this.discoverAppUsers(domain, false);
      return userList.totalUsers;
    } catch (error) {
      this.logger.error(error, "Error getting user count");
      return 0;
    }
  }

  /**
   * 📢 Send broadcast message to all users with same App active
   * @param payload - Message payload to send
   * @param roomId - Optional room ID for room-based messaging
   * @returns Promise that resolves when message is sent
   */
  async broadcastToAppUsers(payload: any, _roomId?: string): Promise<void> {
    try {
      const messageId = this.generateMessageId();

      const message = {
        type: "app_broadcast_message",
        packageName: this.config.packageName,
        sessionId: this.sessionId!,
        payload,
        messageId,
        senderUserId: this.userId,
        timestamp: new Date(),
      };

      this.send(message as any);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to broadcast message: ${errorMessage}`);
    }
  }

  /**
   * 📤 Send direct message to specific user
   * @param targetUserId - User ID to send message to
   * @param payload - Message payload to send
   * @returns Promise that resolves with success status
   */
  async sendDirectMessage(targetUserId: string, payload: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        const messageId = this.generateMessageId();

        // Store promise resolver
        this.pendingDirectMessages.set(messageId, { resolve, reject });

        const message = {
          type: "app_direct_message",
          packageName: this.config.packageName,
          sessionId: this.sessionId!,
          targetUserId,
          payload,
          messageId,
          senderUserId: this.userId,
          timestamp: new Date(),
        };

        this.send(message as any);

        // Set timeout to avoid hanging promises
        const timeoutMs = 15000; // 15 seconds
        this.resources.setTimeout(() => {
          if (this.pendingDirectMessages.has(messageId)) {
            this.pendingDirectMessages.get(messageId)!.reject(new Error("Direct message timed out"));
            this.pendingDirectMessages.delete(messageId);
          }
        }, timeoutMs);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        reject(new Error(`Failed to send direct message: ${errorMessage}`));
      }
    });
  }

  /**
   * 🏠 Join a communication room for group messaging
   * @param roomId - Room ID to join
   * @param roomConfig - Optional room configuration
   * @returns Promise that resolves when room is joined
   */
  async joinAppRoom(
    roomId: string,
    roomConfig?: {
      maxUsers?: number;
      isPrivate?: boolean;
      metadata?: any;
    },
  ): Promise<void> {
    try {
      const message = {
        type: "app_room_join",
        packageName: this.config.packageName,
        sessionId: this.sessionId!,
        roomId,
        roomConfig,
        timestamp: new Date(),
      };

      this.send(message as any);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to join room: ${errorMessage}`);
    }
  }

  /**
   * 🚪 Leave a communication room
   * @param roomId - Room ID to leave
   * @returns Promise that resolves when room is left
   */
  async leaveAppRoom(roomId: string): Promise<void> {
    try {
      const message = {
        type: "app_room_leave",
        packageName: this.config.packageName,
        sessionId: this.sessionId!,
        roomId,
        timestamp: new Date(),
      };

      this.send(message as any);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to leave room: ${errorMessage}`);
    }
  }

  /**
   * 📨 Listen for messages from other App users
   * @param handler - Function to handle incoming messages
   * @returns Cleanup function to remove the handler
   */
  onAppMessage(handler: (message: any) => void): () => void {
    this.appEvents.on("app_message_received", handler);
    return () => this.appEvents.off("app_message_received", handler);
  }

  /**
   * 👋 Listen for user join events
   * @param handler - Function to handle user join events
   * @returns Cleanup function to remove the handler
   */
  onAppUserJoined(handler: (data: any) => void): () => void {
    this.appEvents.on("app_user_joined", handler);
    return () => this.appEvents.off("app_user_joined", handler);
  }

  /**
   * 🚪 Listen for user leave events
   * @param handler - Function to handle user leave events
   * @returns Cleanup function to remove the handler
   */
  onAppUserLeft(handler: (data: any) => void): () => void {
    this.appEvents.on("app_user_left", handler);
    return () => this.appEvents.off("app_user_left", handler);
  }

  /**
   * 🏠 Listen for room update events
   * @param handler - Function to handle room updates
   * @returns Cleanup function to remove the handler
   */
  onAppRoomUpdated(handler: (data: any) => void): () => void {
    this.appEvents.on("app_room_updated", handler);
    return () => this.appEvents.off("app_room_updated", handler);
  }

  /**
   * 🔧 Generate unique message ID
   * @returns Unique message identifier
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

/**
 * @deprecated Use `AppSessionConfig` instead. `TpaSessionConfig` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 *
 * @example
 * ```typescript
 * // ❌ Deprecated - Don't use this
 * const config: TpaSessionConfig = { ... };
 *
 * // ✅ Use this instead
 * const config: AppSessionConfig = { ... };
 * ```
 */
export type TpaSessionConfig = AppSessionConfig;

/**
 * @deprecated Use `AppSession` instead. `TpaSession` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 *
 * @example
 * ```typescript
 * // ❌ Deprecated - Don't use this
 * const session = new TpaSession(config);
 *
 * // ✅ Use this instead
 * const session = new AppSession(config);
 * ```
 */
export class TpaSession extends AppSession {
  constructor(config: TpaSessionConfig) {
    super(config);
    // Emit a deprecation warning to help developers migrate
    console.warn(
      "⚠️  DEPRECATION WARNING: TpaSession is deprecated and will be removed in a future version. " +
        "Please use AppSession instead. " +
        'Simply replace "TpaSession" with "AppSession" in your code.',
    );
  }
}

// Export module classes for developers
export { CameraModule } from "./modules/camera";
export { LedModule } from "./modules/led";
export { AudioManager } from "./modules/audio";
export { SimpleStorage } from "./modules/simple-storage";

// Export module types for developers
export type { PhotoRequestOptions, RtmpStreamOptions } from "./modules/camera";
export type { LedControlOptions } from "./modules/led";
export type { AudioPlayOptions, AudioPlayResult, SpeakOptions } from "./modules/audio";
