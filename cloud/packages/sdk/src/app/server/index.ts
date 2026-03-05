/**
 * 🚀 App Server Module
 *
 * Creates and manages a server for Apps in the MentraOS ecosystem.
 * Handles webhook endpoints, session management, and cleanup.
 */
import express, { type Express } from "express";
import path from "path";
import fs from "fs";
import { AppSession } from "../session/index";
import { createAuthMiddleware } from "../webview";

import {
  WebhookRequest,
  WebhookResponse,
  SessionWebhookRequest,
  StopWebhookRequest,
  ToolCall,
  WebhookRequestType,
  TelemetryLogEntry,
} from "../../types";

import { Logger } from "pino";
import { createLogger } from "../../logging/logger";
import type { MentraLogLevel } from "../../logging/logger";
import axios from "axios";
import { PhotoData } from "../../types/photo-data";
import { getDistTag } from "../../constants/log-messages/updates";

export const GIVE_APP_CONTROL_OF_TOOL_RESPONSE: string = "GIVE_APP_CONTROL_OF_TOOL_RESPONSE";

/**
 * Pending photo request stored at AppServer level
 * This allows O(1) lookup when photo uploads arrive via HTTP,
 * and survives session reconnections.
 * See: cloud/issues/019-sdk-photo-request-architecture
 */
export interface PendingPhotoRequest {
  userId: string;
  sessionId: string;
  session: AppSession;
  resolve: (photo: PhotoData) => void;
  reject: (error: Error) => void;
  timestamp: number;
  timeoutId?: NodeJS.Timeout;
}

/**
 * 🔧 Configuration options for App Server
 *
 * @example
 * ```typescript
 * const config: AppServerConfig = {
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key',
 *   port: 7010,
 *   publicDir: './public'
 * };
 * ```
 */
export interface AppServerConfig {
  /** 📦 Unique identifier for your App (e.g., 'org.company.appname') must match what you specified at https://console.mentra.glass */
  packageName: string;
  /** 🔑 API key for authentication with MentraOS Cloud */
  apiKey: string;
  /** 🌐 Port number for the server (default: 7010) */
  port?: number;

  /** Cloud API URL (default: 'api.mentra.glass') */
  cloudApiUrl?: string;

  /** 🛣️ [DEPRECATED] do not set: The SDK will automatically expose an endpoint at '/webhook' */
  webhookPath?: string;
  /**
   * 📂 Directory for serving static files (e.g., images, logos)
   * Set to false to disable static file serving
   */
  publicDir?: string | false;

  /** ❤️ Enable health check endpoint at /health (default: true) */
  healthCheck?: boolean;
  /**
   * 🔐 Secret key used to sign session cookies
   * This must be a strong, unique secret
   */
  cookieSecret?: string;
  /** App instructions string shown to the user */
  appInstructions?: string;

  /**
   * 📊 Enable telemetry collection for incident debugging.
   * When enabled, the SDK captures internal logs in a ring buffer.
   * Cloud can request these logs when processing bug reports.
   * Default: true (opt-out)
   */
  enableTelemetry?: boolean;
  /**
   * 📊 Maximum number of log entries to keep per user in the telemetry buffer.
   * Default: 1000
   */
  telemetryBufferSize?: number;

  /**
   * SDK console log level. Default: 'warn'.
   * - 'none':  Suppress all SDK console output
   * - 'error': Only errors
   * - 'warn':  Errors + warnings (default)
   * - 'info':  Errors + warnings + lifecycle events
   * - 'debug': Everything (verbose structured output)
   *
   * Can be overridden with MENTRA_LOG_LEVEL env var.
   */
  logLevel?: MentraLogLevel;

  /**
   * Enable verbose internal logging (full structured output).
   * Useful when debugging SDK issues — Mentra support may ask you to enable this.
   * Can also be enabled with MENTRA_VERBOSE=true env var.
   * Default: false
   */
  verbose?: boolean;
}

/**
 * 🎯 App Server Implementation
 *
 * Base class for creating App servers. Handles:
 * - 🔄 Session lifecycle management
 * - 📡 Webhook endpoints for MentraOS Cloud
 * - 📂 Static file serving
 * - ❤️ Health checks
 * - 🧹 Cleanup on shutdown
 *
 * @example
 * ```typescript
 * class MyAppServer extends AppServer {
 *   protected async onSession(session: AppSession, sessionId: string, userId: string) {
 *     // Handle new user sessions here
 *     session.events.onTranscription((data) => {
 *       session.layouts.showTextWall(data.text);
 *     });
 *   }
 * }
 *
 * const server = new MyAppServer({
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key',
 *   publicDir: "/public",
 * });
 *
 * await server.start();
 * ```
 */
export class AppServer {
  /** Express app instance */
  private app: Express;
  /** Map of active user sessions by sessionId */
  private activeSessions = new Map<string, AppSession>();
  /** Map of active user sessions by userId */
  private activeSessionsByUserId = new Map<string, AppSession>();
  /** Array of cleanup handlers to run on shutdown */
  private cleanupHandlers: Array<() => void> = [];
  /** App instructions string shown to the user */
  private appInstructions: string | null = null;
  /**
   * Pending photo requests by requestId - owned by AppServer for HTTP endpoint access.
   * This is the single source of truth for pending photo requests.
   * Stored here (not on CameraModule) because:
   * 1. Photo uploads arrive via HTTP to AppServer, not via WebSocket to session
   * 2. Allows O(1) lookup by requestId instead of iterating all sessions
   * 3. Survives session reconnections (session may be removed from activeSessions temporarily)
   * See: cloud/issues/019-sdk-photo-request-architecture
   */
  private pendingPhotoRequests = new Map<string, PendingPhotoRequest>();
  /**
   * 📊 Telemetry buffer for incident debugging.
   * Maps userId to a ring buffer of log entries.
   * Used to provide recent logs when bug reports are filed.
   */
  private telemetryBuffer = new Map<string, TelemetryLogEntry[]>();
  /** Maximum entries to keep per user in telemetry buffer */
  private telemetryBufferSize: number = 1000;
  /** Whether telemetry collection is enabled */
  private telemetryEnabled: boolean = true;

  public readonly logger: Logger;

  constructor(private config: AppServerConfig) {
    // Set defaults and merge with provided config
    this.config = {
      port: 7010,
      webhookPath: "/webhook",
      publicDir: false,
      healthCheck: true,
      ...config,
    };

    const rootLogger = createLogger({
      logLevel: this.config.logLevel,
      verbose: this.config.verbose,
    });
    this.logger = rootLogger.child({
      app: this.config.packageName,
      packageName: this.config.packageName,
      service: "app-server",
    });

    // Initialize Express app
    this.app = express();
    this.app.use(express.json());

    const cookieParser = require("cookie-parser");
    this.app.use(
      cookieParser(this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`),
    );

    // Apply authentication middleware
    this.app.use(
      createAuthMiddleware({
        apiKey: this.config.apiKey,
        packageName: this.config.packageName,
        getAppSessionForUser: (userId: string) => {
          return this.activeSessionsByUserId.get(userId) || null;
        },
        cookieSecret:
          this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`,
      }) as any,
    );

    this.appInstructions = (config as any).appInstructions || null;

    // Setup telemetry configuration
    this.telemetryEnabled = config.enableTelemetry !== false; // Default: true (opt-out)
    this.telemetryBufferSize = config.telemetryBufferSize || 1000;

    // Setup server features
    this.setupWebhook();
    this.setupSettingsEndpoint();
    this.setupHealthCheck();
    this.setupToolCallEndpoint();
    this.setupPhotoUploadEndpoint();
    this.setupMentraAuthRedirect();
    this.setupPublicDir();
    this.setupShutdown();
  }

  // Expose Express app for custom routes.
  // This is useful for adding custom API routes or middleware.
  public getExpressApp(): Express {
    return this.app;
  }

  /**
   * 👥 Session Handler
   * Override this method to handle new App sessions.
   * This is where you implement your app's core functionality.
   *
   * @param session - App session instance for the user
   * @param sessionId - Unique identifier for this session
   * @param userId - User's identifier
   */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.debug(`Starting new session handling for session ${sessionId} and user ${userId}`);
    // Core session handling logic (onboarding removed)
    this.logger.debug(`Session handling completed for session ${sessionId} and user ${userId}`);
  }

  /**
   * 👥 Stop Handler
   * Override this method to handle stop requests.
   * This is where you can clean up resources when a session is stopped.
   *
   * @param sessionId - Unique identifier for this session
   * @param userId - User's identifier
   * @param reason - Reason for stopping
   */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.logger.debug(`Session ${sessionId} stopped for user ${userId}. Reason: ${reason}`);

    // Default implementation: close the session if it exists
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.disconnect();
      this.activeSessions.delete(sessionId);
      this.activeSessionsByUserId.delete(userId);
    }
  }

  /**
   * 🛠️ Tool Call Handler
   * Override this method to handle tool calls from MentraOS Cloud.
   * This is where you implement your app's tool functionality.
   *
   * @param toolCall - The tool call request containing tool details and parameters
   * @returns Optional string response that will be sent back to MentraOS Cloud
   */
  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    this.logger.debug(`Tool call received: ${toolCall.toolId}`);
    this.logger.debug(`Parameters: ${JSON.stringify(toolCall.toolParameters)}`);
    return undefined;
  }

  /**
   * 🚀 Start the Server
   * Starts listening for incoming connections and webhook calls.
   *
   * @returns Promise that resolves when server is ready
   */
  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.config.port, async () => {
        this.logger.info(`App server running on port ${this.config.port}`);
        if (this.config.publicDir) {
          this.logger.debug(`Serving static files from ${this.config.publicDir}`);
        }

        // 🔑 Grab SDK version
        try {
          // Look for the actual installed @mentra/sdk package.json in node_modules
          const sdkPkgPath = path.resolve(process.cwd(), "node_modules/@mentra/sdk/package.json");

          let currentVersion = "unknown";

          if (fs.existsSync(sdkPkgPath)) {
            const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf-8"));

            // Get the actual installed version
            currentVersion = sdkPkg.version || "not-found"; // located in the node module
          } else {
            this.logger.debug({ sdkPkgPath }, "No @mentra/sdk package.json found at path");
          }

          // this.logger.debug(`Developer is using SDK version: ${currentVersion}`);

          // Determine which dist-tag (release track) the dev is on
          const distTag = getDistTag(currentVersion);

          // Fetch latest SDK version for this track from the API endpoint
          let latest: string | null = null;
          try {
            const cloudHost = "api.mentra.glass";
            const response = await axios.get(`https://${cloudHost}/api/sdk/version`, {
              params: { tag: distTag },
              timeout: 3000, // 3 second timeout
            });
            if (response.data && response.data.success && response.data.data) {
              latest = response.data.data.latest;
            }
          } catch {
            this.logger.debug(
              "Failed to fetch latest SDK version - skipping version check (offline or API unavailable)",
            );
          }

          if (currentVersion === "not-found") {
            this.logger.warn(
              `@mentra/sdk not found in your project dependencies. Install it with: bun install @mentra/sdk`,
            );
          } else if (latest && latest !== currentVersion) {
            this.logger.warn(
              `SDK update available: ${currentVersion} → ${latest} — bun install @mentra/sdk@${distTag}`,
            );
          }
        } catch (err) {
          this.logger.debug(err, "Version check failed");
        }

        resolve();
      });
    });
  }

  /**
   * 🛑 Stop the Server
   * Gracefully shuts down the server and cleans up all sessions.
   */
  public async stop(): Promise<void> {
    this.logger.info("Shutting down...");
    await this.cleanup();
    process.exit(0);
  }

  /**
   * 🔐 Generate a App token for a user
   * This should be called when handling a session webhook request.
   *
   * @param userId - User identifier
   * @param sessionId - Session identifier
   * @param secretKey - Secret key for signing the token
   * @returns JWT token string
   */
  protected generateToken(userId: string, sessionId: string, secretKey: string): string {
    const { createToken } = require("../token/utils");
    return createToken(
      {
        userId,
        packageName: this.config.packageName,
        sessionId,
      },
      { secretKey },
    );
  }

  /**
   * 🧹 Add Cleanup Handler
   * Register a function to be called during server shutdown.
   *
   * @param handler - Function to call during cleanup
   */
  protected addCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.push(handler);
  }

  /**
   * 🎯 Setup Webhook Endpoint
   * Creates the webhook endpoint that MentraOS Cloud calls to start new sessions.
   */
  private setupWebhook(): void {
    if (!this.config.webhookPath) {
      this.logger.error("Webhook path not set");
      throw new Error("Webhook path not set");
    }

    this.app.post(this.config.webhookPath, async (req, res) => {
      try {
        const webhookRequest = req.body as WebhookRequest;

        // Handle session request
        if (webhookRequest.type === WebhookRequestType.SESSION_REQUEST) {
          await this.handleSessionRequest(webhookRequest, res);
        }
        // Handle stop request
        else if (webhookRequest.type === WebhookRequestType.STOP_REQUEST) {
          await this.handleStopRequest(webhookRequest, res);
        }
        // Unknown webhook type
        else {
          this.logger.error("Unknown webhook request type");
          res.status(400).json({
            status: "error",
            message: "Unknown webhook request type",
          } as WebhookResponse);
        }
      } catch (error) {
        this.logger.error(error, "Error handling webhook: " + (error as Error).message);
        res.status(500).json({
          status: "error",
          message: "Error handling webhook: " + (error as Error).message,
        } as WebhookResponse);
      }
    });
  }

  /**
   * 🛠️ Setup Tool Call Endpoint
   * Creates a /tool endpoint for handling tool calls from MentraOS Cloud.
   */
  private setupToolCallEndpoint(): void {
    this.app.post("/tool", async (req, res) => {
      try {
        const toolCall = req.body as ToolCall;
        if (this.activeSessionsByUserId.has(toolCall.userId)) {
          toolCall.activeSession = this.activeSessionsByUserId.get(toolCall.userId) || null;
        } else {
          toolCall.activeSession = null;
        }
        this.logger.debug({ body: req.body }, `Received tool call: ${toolCall.toolId}`);
        // Call the onToolCall handler and get the response
        const response = await this.onToolCall(toolCall);

        // Send back the response if one was provided
        if (response !== undefined) {
          res.json({ status: "success", reply: response });
        } else {
          res.json({ status: "success", reply: null });
        }
      } catch (error) {
        this.logger.error(error, "Error handling tool call");
        res.status(500).json({
          status: "error",
          message: error instanceof Error ? error.message : "Unknown error occurred calling tool",
        });
      }
    });
    this.app.get("/tool", async (req, res) => {
      res.json({ status: "success", reply: "Hello, world!" });
    });
  }

  /**
   * Handle a session request webhook
   */
  private async handleSessionRequest(request: SessionWebhookRequest, res: express.Response): Promise<void> {
    const { sessionId, userId, mentraOSWebsocketUrl, augmentOSWebsocketUrl } = request;
    this.logger.debug({ userId, sessionId }, `Session request for user ${userId}`);

    // Check for existing session (user might be switching clouds)
    // If an existing session exists, we need to clean it up properly to avoid:
    // 1. Orphaned sessions with open WebSockets
    // 2. Cleanup handlers that corrupt the new session's map entries
    // See: cloud/issues/018-app-disconnect-resurrection
    const existingSession = this.activeSessions.get(sessionId);
    if (existingSession) {
      this.logger.debug({ sessionId, userId }, `Existing session found — releasing ownership before new connection`);

      try {
        // Send OWNERSHIP_RELEASE to tell the old cloud not to resurrect this app
        // The old cloud will mark the app as DORMANT instead of trying to restart it
        await existingSession.releaseOwnership("switching_clouds");
      } catch (error) {
        this.logger.debug({ error, sessionId }, `Failed to send OWNERSHIP_RELEASE to old session — continuing`);
      }

      try {
        // Disconnect the old session explicitly
        existingSession.disconnect();
      } catch (error) {
        this.logger.debug({ error, sessionId }, `Failed to disconnect old session — continuing`);
      }

      // Remove from maps immediately (don't wait for cleanup handler)
      this.activeSessions.delete(sessionId);
      this.activeSessionsByUserId.delete(userId);

      this.logger.debug({ sessionId, userId }, `Old session cleaned up`);
    }

    // Create new App session
    const session = new AppSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      mentraOSWebsocketUrl: mentraOSWebsocketUrl || augmentOSWebsocketUrl, // The websocket URL for the specific MentraOS server that this userSession is connecting to.
      appServer: this,
      userId,
    });

    // Setup session event handlers
    const cleanupDisconnect = session.events.onDisconnected((info) => {
      // Determine if this is a permanent disconnect
      // Permanent disconnects happen when:
      // 1. User session ends (sessionEnded === true)
      // 2. Reconnection attempts exhausted (permanent === true)
      // 3. Clean WebSocket closure (1000/1001) - no reconnection will be attempted
      // Temporary disconnects (abnormal closures like 1006 that trigger reconnection) should NOT remove session from maps
      // See: cloud/issues/019-sdk-photo-request-architecture
      let isPermanent = false;
      let reason = "unknown";

      // Handle different disconnect info formats (string or object)
      if (typeof info === "string") {
        this.logger.debug(`Session ${sessionId} disconnected: ${info}`);
        reason = info;
        // String-only disconnects are typically temporary (e.g., "WebSocket closed")
        isPermanent = false;
      } else {
        // It's an object with detailed disconnect information
        this.logger.debug(`Session ${sessionId} disconnected: ${info.message} (code: ${info.code})`);
        reason = info.reason || info.message;

        // Check if this is a user session end event
        // This happens when the UserSession is disposed after 1 minute grace period
        if (info.sessionEnded === true) {
          this.logger.debug(`User session ended for ${sessionId}`);
          isPermanent = true;

          // Call onStop with session end reason
          // This allows apps to clean up resources when the user's session ends
          this.onStop(sessionId, userId, "User session ended").catch((error) => {
            this.logger.error(`Error in onStop handler: ${error instanceof Error ? error.message : error}`);
          });
        }
        // Check if this is a permanent disconnection after exhausted reconnection attempts
        else if (info.permanent === true) {
          this.logger.debug(`Permanent disconnection for session ${sessionId}`);
          isPermanent = true;

          // Call onStop with a reconnection failure reason
          this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`).catch((error) => {
            this.logger.error(`Error in onStop handler: ${error instanceof Error ? error.message : error}`);
          });
        }
        // Check if this is a clean WebSocket closure (1000/1001) that won't trigger reconnection
        // These are intentional disconnects (app shutdown, manual stop, etc.)
        // AppSession skips reconnection for these codes, so we must treat them as permanent
        // to avoid zombie sessions in activeSessions map
        else if (info.wasClean === true || info.code === 1000 || info.code === 1001) {
          this.logger.debug(`Clean WebSocket closure for session ${sessionId} (code: ${info.code})`);
          isPermanent = true;

          // Call onStop for clean disconnects too
          this.onStop(sessionId, userId, `Clean disconnect: ${reason}`).catch((error) => {
            this.logger.error(`Error in onStop handler: ${error instanceof Error ? error.message : error}`);
          });
        }
      }

      // Only remove session and clean up photo requests on PERMANENT disconnects
      // Temporary disconnects should leave the session in place so:
      // 1. Photo uploads can still find the pending request
      // 2. The session can be reused after reconnection
      // See: cloud/issues/019-sdk-photo-request-architecture
      if (isPermanent) {
        // Remove the session from active sessions ONLY if this session is still the active one.
        // This prevents a bug where an old session's cleanup handler deletes a newer session:
        // 1. User switches from Cloud A to Cloud B
        // 2. SDK creates sessionB, overwrites activeSessions[sessionId]
        // 3. sessionA is orphaned but its cleanup handler still references sessionId
        // 4. When Cloud A disposes, sessionA's cleanup fires and would delete sessionB
        // By checking identity (===), we only delete if we're still the current session.
        // See: cloud/issues/018-app-disconnect-resurrection
        if (this.activeSessions.get(sessionId) === session) {
          this.activeSessions.delete(sessionId);
        } else {
          this.logger.debug({ sessionId }, `Session ${sessionId} cleanup skipped — newer session has taken over`);
        }
        if (this.activeSessionsByUserId.get(userId) === session) {
          this.activeSessionsByUserId.delete(userId);
        }

        // Clean up any pending photo requests for this session
        this.cleanupPhotoRequestsForSession(sessionId);

        // Clean up telemetry buffer to prevent memory leak
        this.clearTelemetryBuffer(userId);
      } else {
        // Temporary disconnect - session stays in maps for reconnection
        // Photo requests remain pending and can still be fulfilled
        this.logger.debug(
          { sessionId, reason },
          `Temporary disconnect for session ${sessionId} — keeping for reconnection`,
        );
      }
    });

    // Error logging is now handled by EventManager's fallback (logs if no onError handler).
    // No internal cleanupError handler needed — avoids double-logging.

    // Start the session
    try {
      await session.connect(sessionId);
      this.activeSessions.set(sessionId, session);
      this.activeSessionsByUserId.set(userId, session);
      await this.onSession(session, sessionId, userId);
      res.status(200).json({ status: "success" } as WebhookResponse);
    } catch (error) {
      this.logger.error(`Failed to connect: ${error instanceof Error ? error.message : error}`);
      cleanupDisconnect();
      res.status(500).json({
        status: "error",
        message: "Failed to connect",
      } as WebhookResponse);
    }
  }

  /**
   * Handle a stop request webhook
   */
  private async handleStopRequest(request: StopWebhookRequest, res: express.Response): Promise<void> {
    const { sessionId, userId, reason } = request;
    this.logger.debug(`Stop request for user ${userId}, session ${sessionId}: ${reason}`);

    try {
      await this.onStop(sessionId, userId, reason);
      res.status(200).json({ status: "success" } as WebhookResponse);
    } catch (error) {
      this.logger.error(`Error handling stop request: ${error instanceof Error ? error.message : error}`);
      res.status(500).json({
        status: "error",
        message: "Failed to process stop request",
      } as WebhookResponse);
    }
  }

  /**
   * ❤️ Setup Health Check Endpoint
   * Creates a /health endpoint for monitoring server status.
   */
  private setupHealthCheck(): void {
    if (this.config.healthCheck) {
      this.app.get("/health", (req, res) => {
        res.json({
          status: "healthy",
          app: this.config.packageName,
          activeSessions: this.activeSessions.size,
        });
      });
    }
  }

  /**
   * ⚙️ Setup Settings Endpoint
   * Creates a /settings endpoint that the MentraOS Cloud can use to update settings.
   */
  private setupSettingsEndpoint(): void {
    this.app.post("/settings", async (req, res) => {
      try {
        const { userIdForSettings, settings } = req.body;

        if (!userIdForSettings || !Array.isArray(settings)) {
          return res.status(400).json({
            status: "error",
            message: "Missing userId or settings array in request body",
          });
        }

        this.logger.debug(`Settings update for user ${userIdForSettings}`);

        // Find all active sessions for this user
        const userSessions: AppSession[] = [];

        // Look through all active sessions
        this.activeSessions.forEach((session, _sessionId) => {
          // Check if the session has this userId (not directly accessible)
          // We're relying on the webhook handler to have already verified this
          if (session.userId === userIdForSettings) {
            userSessions.push(session);
          }
        });

        if (userSessions.length === 0) {
          this.logger.debug(`No active sessions found for user ${userIdForSettings}`);
        } else {
          this.logger.debug(`Updating settings for ${userSessions.length} active sessions`);
        }

        // Update settings for all of the user's sessions
        for (const session of userSessions) {
          session.updateSettingsForTesting(settings);
        }

        // Allow subclasses to handle settings updates if they implement the method
        if (typeof (this as any).onSettingsUpdate === "function") {
          await (this as any).onSettingsUpdate(userIdForSettings, settings);
        }

        res.json({
          status: "success",
          message: "Settings updated successfully",
          sessionsUpdated: userSessions.length,
        });
      } catch (error) {
        this.logger.error(`Error handling settings update: ${error instanceof Error ? error.message : error}`);
        res.status(500).json({
          status: "error",
          message: "Internal server error processing settings update",
        });
      }
    });
  }

  /**
   * 📂 Setup Static File Serving
   * Configures Express to serve static files from the specified directory.
   */
  private setupPublicDir(): void {
    if (this.config.publicDir) {
      const publicPath = path.resolve(this.config.publicDir);
      this.app.use(express.static(publicPath));
      this.logger.debug(`Serving static files from ${publicPath}`);
    }
  }

  /**
   * 🛑 Setup Shutdown Handlers
   * Registers process signal handlers for graceful shutdown.
   */
  private setupShutdown(): void {
    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());
  }

  /**
   * 🧹 Cleanup
   * Closes all active sessions and runs cleanup handlers.
   * Does NOT release ownership - we want the cloud to resurrect when we come back up.
   *
   * OWNERSHIP_RELEASE should only be sent for:
   * - switching_clouds: User moved to another cloud, don't compete
   * - user_logout: User explicitly logged out
   *
   * NOT for clean_shutdown, because:
   * - Server is restarting/redeploying
   * - Cloud should resurrect the app (trigger webhook)
   * - User expects their app to keep running
   *
   * See: cloud/issues/023-disposed-appsession-resurrection-bug
   */
  private async cleanup(): Promise<void> {
    this.logger.debug(`Cleanup called — not sending OWNERSHIP_RELEASE`);
    // Close all active sessions WITHOUT releasing ownership
    // This allows the cloud to resurrect apps when we come back up
    for (const [sessionId, session] of this.activeSessions) {
      this.logger.debug(`Closing session ${sessionId} (cloud will resurrect)`);
      try {
        // Just disconnect, don't release ownership
        // The cloud will enter grace period and then resurrect via webhook
        await session.disconnect({
          releaseOwnership: false,
        });
      } catch (error) {
        this.logger.error(
          `Error during cleanup of session ${sessionId}: ${error instanceof Error ? error.message : error}`,
        );
        // Still try to disconnect even if release fails
        try {
          await session.disconnect();
        } catch {
          // Ignore secondary errors
        }
      }
    }
    this.activeSessions.clear();
    this.activeSessionsByUserId.clear();

    // Run cleanup handlers
    this.cleanupHandlers.forEach((handler) => handler());
  }

  /**
   * 🎯 Setup Photo Upload Endpoint
   * Creates a /photo-upload endpoint for receiving photos directly from ASG glasses
   */
  private setupPhotoUploadEndpoint(): void {
    const multer = require("multer");

    // Configure multer for handling multipart form data
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
      },
      fileFilter: (req: any, file: any, cb: any) => {
        // Accept image files only
        if (file.mimetype && file.mimetype.startsWith("image/")) {
          cb(null, true);
        } else {
          cb(new Error("Only image files are allowed"), false);
        }
      },
    });

    this.app.post("/photo-upload", upload.single("photo"), async (req: any, res: any) => {
      try {
        const { requestId, type, success, errorCode, errorMessage } = req.body;
        const photoFile = req.file;

        this.logger.debug({ requestId, type, success, errorCode }, `Photo response: ${requestId} (type: ${type})`);

        if (!requestId) {
          this.logger.warn("No requestId in photo response");
          return res.status(400).json({
            success: false,
            error: "No requestId provided",
          });
        }

        // Direct O(1) lookup from AppServer's pending photo requests map
        // This is the new architecture that survives session reconnections
        // See: cloud/issues/019-sdk-photo-request-architecture
        const pending = this.completePhotoRequest(requestId);
        if (!pending) {
          this.logger.debug(
            { requestId, pendingCount: this.pendingPhotoRequests.size },
            "No pending request found for photo (may have timed out or session ended)",
          );
          return res.status(404).json({
            success: false,
            error: "No pending request found for this photo (may have timed out or session ended)",
          });
        }

        // Handle error response (no photo file, but has error info)
        if (type === "photo_error" || success === false) {
          const errorMsg = errorMessage || "Unknown error occurred";
          this.logger.debug({ requestId, errorCode, errorMessage: errorMsg }, "Photo error received");
          pending.reject(new Error(`Photo capture failed: ${errorMsg} (code: ${errorCode || "UNKNOWN_ERROR"})`));

          // Respond to ASG client
          return res.json({
            success: true,
            requestId,
            message: "Photo error received successfully",
          });
        }

        // Handle successful photo upload
        if (!photoFile) {
          this.logger.warn({ requestId }, "No photo file in successful upload");
          pending.reject(new Error("No photo file provided for successful upload"));
          return res.status(400).json({
            success: false,
            error: "No photo file provided for successful upload",
          });
        }

        // Create photo data object and resolve the promise
        const photoData: PhotoData = {
          buffer: photoFile.buffer,
          mimeType: photoFile.mimetype,
          filename: photoFile.originalname || "photo.jpg",
          requestId,
          size: photoFile.size,
          timestamp: new Date(),
        };

        this.logger.debug(
          { requestId, size: photoFile.size, mimeType: photoFile.mimetype },
          "Photo received, resolving promise",
        );
        pending.resolve(photoData);

        // Respond to ASG client
        res.json({
          success: true,
          requestId,
          message: "Photo received successfully",
        });
      } catch (error) {
        this.logger.error(`Error handling photo response: ${error instanceof Error ? error.message : error}`);
        res.status(500).json({
          success: false,
          error: "Internal server error processing photo response",
        });
      }
    });
  }

  // =====================================
  // 📸 Photo Request Management APIs
  // =====================================

  /**
   * Register a pending photo request.
   * Called by CameraModule when a photo is requested.
   * Stores the request at AppServer level for O(1) lookup when HTTP response arrives.
   *
   * @param requestId - Unique identifier for this photo request
   * @param request - Request details including session, resolve/reject callbacks
   */
  registerPhotoRequest(requestId: string, request: Omit<PendingPhotoRequest, "timeoutId">): void {
    // Set timeout at AppServer level (single source of truth)
    const timeoutMs = 30000; // 30 seconds
    const timeoutId = setTimeout(() => {
      const pending = this.pendingPhotoRequests.get(requestId);
      if (pending) {
        pending.reject(new Error("Photo request timed out"));
        this.pendingPhotoRequests.delete(requestId);
        this.logger.warn({ requestId }, "Photo request timed out");
      }
    }, timeoutMs);

    this.pendingPhotoRequests.set(requestId, {
      ...request,
      timeoutId,
    });

    this.logger.debug({ requestId, userId: request.userId, sessionId: request.sessionId }, "Photo request registered");
  }

  /**
   * Get a pending photo request by ID.
   *
   * @param requestId - The request ID to look up
   * @returns The pending request, or undefined if not found
   */
  getPhotoRequest(requestId: string): PendingPhotoRequest | undefined {
    return this.pendingPhotoRequests.get(requestId);
  }

  /**
   * Complete a photo request (success or error).
   * Clears the timeout and removes from the pending map.
   *
   * @param requestId - The request ID to complete
   * @returns The pending request that was completed, or undefined if not found
   */
  completePhotoRequest(requestId: string): PendingPhotoRequest | undefined {
    const pending = this.pendingPhotoRequests.get(requestId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingPhotoRequests.delete(requestId);
      this.logger.debug({ requestId }, "Photo request completed");
    }
    return pending;
  }

  /**
   * Clean up all pending photo requests for a session.
   * Called when a session permanently disconnects.
   *
   * @param sessionId - The session ID to clean up requests for
   */
  cleanupPhotoRequestsForSession(sessionId: string): void {
    let cleanedCount = 0;
    for (const [requestId, pending] of this.pendingPhotoRequests) {
      if (pending.sessionId === sessionId) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        pending.reject(new Error("Session ended"));
        this.pendingPhotoRequests.delete(requestId);
        cleanedCount++;
        this.logger.debug({ requestId, sessionId }, "Photo request cleaned up (session ended)");
      }
    }
    if (cleanedCount > 0) {
      this.logger.debug({ sessionId, cleanedCount }, "Cleaned up photo requests for ended session");
    }
  }

  // =====================================
  // 📊 Telemetry Methods
  // =====================================

  /**
   * 📊 Log a telemetry entry for a user.
   * This method is called internally by the SDK to capture logs.
   * Apps can also call this to add custom telemetry.
   *
   * @param userId - User ID to associate the log with
   * @param level - Log level
   * @param message - Log message
   * @param source - Source of the log (e.g., "session", "camera", "display")
   * @param data - Optional additional data
   */
  public logTelemetry(
    userId: string,
    level: TelemetryLogEntry["level"],
    message: string,
    source?: string,
    data?: unknown,
  ): void {
    if (!this.telemetryEnabled) return;

    const entry: TelemetryLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      source,
      data,
    };

    let buffer = this.telemetryBuffer.get(userId);
    if (!buffer) {
      buffer = [];
      this.telemetryBuffer.set(userId, buffer);
    }

    buffer.push(entry);

    // Ring buffer: remove oldest if over limit
    while (buffer.length > this.telemetryBufferSize) {
      buffer.shift();
    }
  }

  /**
   * 📊 Get telemetry logs for a user within a time window.
   *
   * @param userId - User ID to get logs for
   * @param windowMs - Time window in milliseconds (logs newer than now - windowMs)
   * @returns Array of telemetry log entries within the time window
   */
  public getTelemetryLogs(userId: string, windowMs: number): TelemetryLogEntry[] {
    const buffer = this.telemetryBuffer.get(userId);
    if (!buffer || buffer.length === 0) {
      return [];
    }

    const cutoff = Date.now() - windowMs;
    return buffer.filter((entry) => entry.timestamp >= cutoff);
  }

  /**
   * 📊 Clear telemetry buffer for a user.
   * Called when a session permanently disconnects.
   *
   * @param userId - User ID to clear telemetry for
   */
  private clearTelemetryBuffer(userId: string): void {
    this.telemetryBuffer.delete(userId);
  }

  /**
   * 🔐 Setup Mentra Auth Redirect Endpoint
   * Creates a /mentra-auth endpoint that redirects to the MentraOS OAuth flow.
   */
  private setupMentraAuthRedirect(): void {
    this.app.get("/mentra-auth", (req, res) => {
      // Redirect to the account.mentra.glass OAuth flow with the app's package name
      const authUrl = `https://account.mentra.glass/auth?packagename=${encodeURIComponent(this.config.packageName)}`;

      this.logger.debug(`Redirecting to MentraOS OAuth flow: ${authUrl}`);

      res.redirect(302, authUrl);
    });
  }
}

/**
 * @deprecated Use `AppServerConfig` instead. `TpaServerConfig` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 *
 * @example
 * ```typescript
 * // ❌ Deprecated - Don't use this
 * const config: TpaServerConfig = { ... };
 *
 * // ✅ Use this instead
 * const config: AppServerConfig = { ... };
 * ```
 */
export type TpaServerConfig = AppServerConfig;

/**
 * @deprecated Use `AppServer` instead. `TpaServer` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 *
 * @example
 * ```typescript
 * // ❌ Deprecated - Don't use this
 * class MyServer extends TpaServer { ... }
 *
 * // ✅ Use this instead
 * class MyServer extends AppServer { ... }
 * ```
 */
export class TpaServer extends AppServer {
  constructor(config: TpaServerConfig) {
    super(config);
    // Emit a deprecation warning to help developers migrate
    console.warn(
      "⚠️  DEPRECATION WARNING: TpaServer is deprecated and will be removed in a future version. " +
        "Please use AppServer instead. " +
        'Simply replace "TpaServer" with "AppServer" in your code.',
    );
  }
}
