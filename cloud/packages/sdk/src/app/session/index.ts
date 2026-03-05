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
import { WebSocket } from "ws";
import { EventManager, EventData } from "./events";
import { LayoutManager } from "./layouts";
import { SettingsManager } from "./settings";
import { LocationManager } from "./modules/location";
import { CameraModule } from "./modules/camera";
import { LedModule } from "./modules/led";
import { AudioManager } from "./modules/audio";
import { ResourceTracker } from "../../utils/resource-tracker";
import {
  MentraAuthError,
  MentraConnectionError,
  MentraTimeoutError,
  MentraValidationError,
  MentraError,
} from "../../logging/errors";
import {
  // Message types
  AppToCloudMessage,
  CloudToAppMessage,
  AppConnectionInit,
  AppSubscriptionUpdate,
  AudioPlayResponse,
  RequestWifiSetup,
  OwnershipReleaseMessage,
  AppToCloudMessageType,
  CloudToAppMessageType,

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
  RequestTelemetry,
} from "../../types/messages/cloud-to-app";
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
  /** Unique identifier for your App (e.g., 'org.company.appname') */
  packageName: string;
  /** API key for authentication with MentraOS Cloud */
  apiKey: string;

  /**
   * WebSocket URL for the MentraOS Cloud instance this session connects to.
   *
   * @internal Set automatically by AppServer from the session webhook — you
   * should never need to specify this yourself. If you find yourself setting
   * this manually, you're likely constructing an AppSession directly instead
   * of using AppServer (the supported pattern).
   *
   * @deprecated Will be removed in a future major version. Use AppServer
   * which receives the URL from MentraOS Cloud automatically.
   */
  mentraOSWebsocketUrl?: string;

  /** Automatically attempt to reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Maximum number of reconnection attempts (default: 3) */
  maxReconnectAttempts?: number;
  /** Base delay between reconnection attempts in ms (default: 1000) */
  reconnectDelay?: number;

  /** User ID for tracking sessions (email of the user). */
  userId: string;
  /**
   * @internal The AppServer instance that owns this session.
   * Set automatically — do not provide manually.
   */
  appServer: AppServer;
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
    this.logger = this.appServer.logger.child({
      userId: this.config.userId,
      service: "app-session",
    });
    this.userId = this.config.userId;

    // Validate and fix WebSocket URL format (consolidated — previously two duplicate blocks)
    if (this.config.mentraOSWebsocketUrl) {
      try {
        const url = new URL(this.config.mentraOSWebsocketUrl);
        if (!["ws:", "wss:"].includes(url.protocol)) {
          // Fix URLs with incorrect protocol (e.g., 'ws://http://host')
          const fixedUrl = this.config.mentraOSWebsocketUrl.replace(/^ws:\/\/http:\/\//, "ws://");
          this.config.mentraOSWebsocketUrl = fixedUrl;
          this.logger.debug(`Fixed malformed WebSocket URL: ${fixedUrl}`);
        }
      } catch {
        this.logger.error(`Invalid WebSocket URL: ${this.config.mentraOSWebsocketUrl}`);
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
      this.logger, // Pass logger for proper DI (no more direct root logger import)
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
    readNotificationWarnLog(this.getHttpsServerUrl() || "", this.getPackageName(), "onPhoneNotifications", this.logger);
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
          reject(new MentraValidationError("WebSocket URL is required"));
          return;
        }

        // Connection attempt — debug level (success is logged at info in the ACK handler)
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
            // Reject only — no log, no emit. The rejection is the output path.
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
                // Emit only — the error event is the output path
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
              const errorMessage = error instanceof Error ? error.message : String(error);
              this.events.emit("error", new MentraError(`Failed to parse message: ${errorMessage}`, "PARSE_ERROR"));
            }
          } catch (error: unknown) {
            // Final catch - should never reach here if individual handlers work correctly
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
            code,
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

          // Log closure details for diagnostics
          this.logger.debug(`WebSocket closed with code ${code}${reasonStr}`);
          this.logger.debug(
            `isNormalClosure: ${isNormalClosure}, isManualStop: ${isManualStop}, isUserSessionEnded: ${isUserSessionEnded}`,
          );

          // If user session ended, mark as terminated to prevent any future reconnection
          if (isUserSessionEnded) {
            this.terminated = true;
            this.logger.debug(`User session ended — marking as terminated, no reconnection allowed`);
          }

          if (!isNormalClosure && !isManualStop && !this.terminated) {
            this.handleReconnection();
          } else {
            this.logger.debug(
              `Normal/terminated closure — not attempting reconnection (terminated: ${this.terminated})`,
            );
          }

          // if user session ended, then trigger onStop.
          if (isUserSessionEnded) {
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

        // Connection error handler — single handler, emit only, contextual message.
        // No logger.error — the error event is the output path.
        // EventManager's fallback handles logging if no onError handler exists.
        const errorHandler = (error: Error) => {
          const msg = error.message || "";
          let userMessage: string;

          if (msg.includes("ECONNREFUSED")) {
            userMessage = "Connection refused — is MentraOS Cloud running?";
          } else if (msg.includes("ETIMEDOUT")) {
            userMessage = "Connection timed out — check network connectivity";
          } else {
            userMessage = error.message;
          }

          this.events.emit("error", new MentraConnectionError(userMessage));
        };

        this.ws.on("error", errorHandler);

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
          // Reject only — no log, no emit. The rejection is the output path.
          const err = new MentraTimeoutError(`Connection timeout after ${timeoutMs}ms`);
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
            `CONNECTION_ACK mentraosSettings`,
          );
          if (message.mentraosSettings) {
            this.settings.updateMentraosSettings(message.mentraosSettings);
          } else {
            this.logger.debug(`CONNECTION_ACK message missing mentraosSettings field`);
          }

          // Handle device capabilities if provided
          if (message.capabilities) {
            this.capabilities = message.capabilities;
            this.logger.debug(`Device capabilities loaded for model: ${message.capabilities.modelName}`);
          } else {
            this.logger.debug(`No capabilities provided in CONNECTION_ACK`);
          }

          // Emit connected event with settings
          this.events.emit("connected", this.settingsData);

          // Log once to confirm Bug 007 fix is active (subscriptions derived from handlers)
          const handlerCount = this.events.getRegisteredStreams().length;
          this.logger.debug(
            { patch: SDK_SUBSCRIPTION_PATCH, handlerCount },
            `Subscriptions derived from ${handlerCount} handler(s)`,
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
          if (
            errorMessage.toLowerCase().includes("invalid api key") ||
            errorMessage.toLowerCase().includes("auth") ||
            errorMessage.toLowerCase().includes("unauthorized")
          ) {
            this.events.emit("error", new MentraAuthError(errorMessage));
          } else {
            this.events.emit("error", new MentraConnectionError(errorMessage));
          }
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
          const messageStreamType = message.streamType as ExtendedStreamType;

          // Use language-aware matching: "transcription:en-US" matches handler
          // for "transcription:en-US?hints=ja" (same base language, different options).
          // This ensures apps receive data after stream dedup normalizes streamType
          // to base language form, AND maintains backward compat when cloud sends
          // the app's own subscription string (which includes options).
          const matchedStreamType = this.events.findMatchingStream(messageStreamType);

          if (matchedStreamType) {
            const sanitizedData = this.sanitizeEventData(matchedStreamType, message.data) as EventData<
              typeof matchedStreamType
            >;
            this.events.emit(matchedStreamType, sanitizedData);
          } else if (messageStreamType) {
            // Log unmatched DataStream for debugging (previously a silent black hole)
            this.logger.debug(
              {
                streamType: messageStreamType,
                registeredStreams: this.events.getRegisteredStreams(),
              },
              `[AppSession] Received DataStream with no matching handler: ${messageStreamType}`,
            );
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
          this.logger.debug(
            capabilitiesMessage.capabilities,
            `Capabilities updated for model: ${capabilitiesMessage.modelName}`,
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
          this.logger.debug(`Received APP_STOPPED message: ${displayReason}`);

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
          const errorMessage = (message as any).message || "Unknown connection error (type: connection_error)";
          this.logger.warn(
            `Received 'connection_error' type directly. Consider aligning cloud to send 'tpa_connection_error'. Message: ${errorMessage}`,
          );
          this.events.emit("error", new MentraConnectionError(errorMessage));
        } else if (message.type === "permission_error") {
          // Handle permission errors from cloud
          // Emit permission error event for application handling — no log, let the dev's handler decide
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
        } else if (isAudioPlayResponse(message)) {
          // Delegate audio play response handling to the audio module
          if (this.audio) {
            this.audio.handleAudioPlayResponse(message as AudioPlayResponse);
          }
        } else if (isPhotoResponse(message)) {
          const photoResponse = message as import("../../types/messages/glasses-to-cloud").PhotoResponse;
          const { requestId, success } = photoResponse;

          if (!success && requestId) {
            // Photo error — reject the pending Promise immediately instead of waiting for 30s timeout
            const errorCode = photoResponse.error?.code || "UNKNOWN_ERROR";
            const errorMsg = photoResponse.error?.message || "Photo capture failed";
            this.logger.warn(
              { requestId, errorCode, errorMsg },
              `📸 Photo error received via WebSocket — rejecting pending request`,
            );

            const pending = this.appServer?.completePhotoRequest(requestId);
            if (pending) {
              pending.reject(new Error(`Photo capture failed: ${errorMsg} (code: ${errorCode})`));
            } else {
              this.logger.debug(
                { requestId },
                "📸 No pending photo request found for error response (may have already timed out)",
              );
            }
          } else {
            // Success responses should come via /photo-upload HTTP endpoint, not WebSocket
            this.logger.debug(
              { requestId },
              "Received photo success via WebSocket — photos should arrive via /photo-upload webhook",
            );
          }
        } else if (isRgbLedControlResponse(message)) {
          // LED control responses are no longer handled - fire-and-forget mode
          this.logger.debug({ message }, "Received LED control response (ignored - fire-and-forget mode)");
        } else if (message.type === CloudToAppMessageType.REQUEST_TELEMETRY) {
          // Handle telemetry request from cloud (for incident debugging)
          this.handleTelemetryRequest(message as RequestTelemetry);
        }
        // Handle unrecognized message types gracefully — warn only, not an error
        // Unknown message types are unexpected but not something the dev can act on
        else {
          this.logger.warn(`Unrecognized message type: ${(message as any).type}`);
        }
      } catch (processingError: unknown) {
        // Catch any errors during message processing to prevent App crashes
        const errorMessage = processingError instanceof Error ? processingError.message : String(processingError);
        this.events.emit("error", new MentraError(`Error processing message: ${errorMessage}`, "INTERNAL_ERROR"));
      }
    } catch (error: unknown) {
      // Final safety net to ensure the App doesn't crash on any unexpected errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit(
        "error",
        new MentraError(`Unexpected error in message handler: ${errorMessage}`, "INTERNAL_ERROR"),
      );
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
  /**
   * 📊 Handle telemetry request from cloud (for incident debugging).
   * When a user files a bug report, cloud sends this message to collect SDK logs.
   * The SDK responds by POSTing its buffered logs to the incident logs endpoint.
   */
  private async handleTelemetryRequest(message: RequestTelemetry): Promise<void> {
    const { incidentId, uploadToken, windowMs } = message;

    // uploadToken is required for secure telemetry uploads
    if (!uploadToken) {
      this.logger.warn({ incidentId }, "📊 No uploadToken provided - skipping telemetry upload");
      return;
    }

    // Get telemetry logs from AppServer's buffer
    const logs = this.appServer.getTelemetryLogs(this.userId, windowMs || 10 * 60 * 1000);

    if (logs.length === 0) {
      this.logger.debug({ incidentId }, "📊 No telemetry logs to send");
      return;
    }

    // POST logs to the incident logs endpoint
    // Derive cloud API URL from the WebSocket URL we connected to
    try {
      const cloudHost = this.getHttpsServerUrl() || "https://api.mentra.glass";
      const response = await axios.post(
        `${cloudHost}/api/incidents/${incidentId}/logs`,
        {
          logs,
          uploadToken,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-App-Api-Key": this.config.apiKey,
            "X-App-Package": this.config.packageName,
          },
          timeout: 10000,
        },
      );

      this.logger.info({ incidentId, count: logs.length, status: response.status }, "📊 Telemetry logs sent to cloud");
    } catch (err) {
      this.logger.warn({ incidentId, err }, "📊 Failed to send telemetry logs");
    }
  }

  private handleBinaryMessage(buffer: ArrayBuffer): void {
    try {
      // Safety check - only process if we have a handler registered (derived from handlers)
      const hasAudioHandler = this.events.getRegisteredStreams().includes(StreamType.AUDIO_CHUNK);
      if (!hasAudioHandler) {
        return;
      }

      // Validate buffer has content before processing
      if (!buffer || buffer.byteLength === 0) {
        this.events.emit("error", new MentraError("Received empty binary message", "PARSE_ERROR"));
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
      // Emit only — the error event is the output path
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.events.emit("error", new MentraError(`Error processing binary message: ${errorMessage}`, "PARSE_ERROR"));
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
      this.logger.debug(`Reconnection skipped: session was terminated (User session ended)`);
      return;
    }

    // Check if reconnection is allowed
    if (!this.config.autoReconnect || !this.sessionId) {
      this.logger.debug(
        `Reconnection skipped: autoReconnect=${this.config.autoReconnect}, sessionId=${
          this.sessionId ? "valid" : "invalid"
        }`,
      );
      return;
    }

    // Check if we've exceeded the maximum attempts
    const maxAttempts = this.config.maxReconnectAttempts || 3;
    if (this.reconnectAttempts >= maxAttempts) {
      this.logger.error(`Connection lost after ${maxAttempts} attempts`);

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
      this.logger.info(`Reconnected — user ${this.userId}`);
      this.reconnectAttempts = 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Emit only — the error event is the output path
      this.events.emit("error", new MentraConnectionError(`Reconnection failed: ${errorMessage}`));

      // Check if this was the last attempt
      if (this.reconnectAttempts >= maxAttempts) {
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

      if (!isDisconnectError) {
        // Only emit for real errors — disconnect errors are expected during session teardown
        if (error instanceof Error) {
          this.events.emit("error", error);
        } else {
          this.events.emit("error", new Error(String(error)));
        }
      }
      // Disconnect errors: no log, no emit — expected during session teardown

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

// Export module types for developers
export { CameraModule, PhotoRequestOptions, RtmpStreamOptions } from "./modules/camera";
export { LedModule, LedControlOptions } from "./modules/led";
export { AudioManager, AudioPlayOptions, AudioPlayResult, SpeakOptions } from "./modules/audio";
export { SimpleStorage } from "./modules/simple-storage";
