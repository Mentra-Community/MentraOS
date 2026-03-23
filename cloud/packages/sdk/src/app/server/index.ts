/**
 * App Server Module
 *
 * Creates and manages a server for Apps in the MentraOS ecosystem.
 * Handles webhook endpoints, session management, and cleanup.
 *
 * Now built on Hono + Bun for better performance and developer experience.
 */
import fs from "fs";
import path from "path";

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { serveStatic } from "hono/bun";
import { Logger } from "pino";

import { getDistTag } from "../../constants/log-messages/updates";
import { createLogger } from "../../logging/logger";
import {
  WebhookRequest,
  WebhookResponse,
  SessionWebhookRequest,
  StopWebhookRequest,
  ToolCall,
  WebhookRequestType,
  AuthVariables,
} from "../../types";

import { AppSession } from "../session/index";
import { createAuthMiddleware } from "../webview";

// Import PhotoData type for pending photo requests
import type { PhotoData } from "../../types/photo-data";

export const GIVE_APP_CONTROL_OF_TOOL_RESPONSE: string = "GIVE_APP_CONTROL_OF_TOOL_RESPONSE";

/**
 * Pending photo request stored at AppServer level for reconnection resilience.
 * This allows O(1) lookup when photo uploads arrive via HTTP,
 * and survives session reconnections.
 * See: cloud/issues/019-sdk-photo-request-architecture
 */
interface PendingPhotoRequest {
  userId: string;
  sessionId: string;
  session: AppSession;
  resolve: (photo: PhotoData) => void;
  reject: (error: Error) => void;
  timestamp: number;
  timeoutId?: ReturnType<typeof setTimeout>;
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
}

// Type for Hono app with auth variables
type AppHono = Hono<{ Variables: AuthVariables }>;

/**
 * 🎯 App Server Implementation
 *
 * Base class for creating App servers, now extending Hono for a modern API.
 * Handles:
 * - 🔄 Session lifecycle management
 * - 📡 Webhook endpoints for MentraOS Cloud
 * - 📂 Static file serving
 * - ❤️ Health checks
 * - 🧹 Cleanup on shutdown
 *
 * @example
 * ```typescript
 * class MyAppServer extends AppServer {
 *   constructor(config: AppServerConfig) {
 *     super(config)
 *
 *     // Add custom API routes (Hono syntax)
 *     this.get("/api/custom", (c) => c.json({ message: "Hello!" }))
 *   }
 *
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
 * });
 *
 * await server.start();
 * ```
 */
export class AppServer extends Hono<{ Variables: AuthVariables }> {
  /** Server configuration */
  protected config: AppServerConfig;
  /** Map of active user sessions by sessionId */
  private activeSessions = new Map<string, AppSession>();
  /** Map of active user sessions by userId */
  private activeSessionsByUserId = new Map<string, AppSession>();
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
  /** Array of cleanup handlers to run on shutdown */
  private cleanupHandlers: Array<() => void> = [];
  /** App instructions string shown to the user */
  private appInstructions: string | null = null;

  public readonly logger: Logger;

  constructor(config: AppServerConfig) {
    super(); // Initialize Hono

    // Set defaults and merge with provided config
    this.config = {
      port: 7010,
      webhookPath: "/webhook",
      publicDir: false,
      healthCheck: true,
      ...config,
    };

    this.logger = createLogger().child({
      app: this.config.packageName,
      packageName: this.config.packageName,
      service: "app-server",
    });

    // Apply authentication middleware
    this.use(
      "*",
      createAuthMiddleware({
        apiKey: this.config.apiKey,
        packageName: this.config.packageName,
        getAppSessionForUser: (userId: string) => {
          return this.activeSessionsByUserId.get(userId) || null;
        },
        cookieSecret: this.config.cookieSecret || this.config.apiKey, // Default to apiKey for simplicity
      }),
    );

    this.appInstructions = (config as any).appInstructions || null;

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

  /**
   * @deprecated Use `this.get()`, `this.post()`, etc. directly since AppServer now extends Hono
   * This method is kept for backward compatibility during migration.
   */
  public getExpressApp(): AppHono {
    console.warn(
      "DEPRECATION: getExpressApp() is deprecated. AppServer now extends Hono - use this.get(), this.post(), etc. directly.",
    );
    return this as AppHono;
  }

  /**
   * Get the Hono app instance (returns this since AppServer extends Hono)
   */
  public getHonoApp(): AppHono {
    return this as AppHono;
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
    this.logger.debug({ sessionId, userId }, "Session handler started");
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
   * 🚀 Initialize the App
   * Sets up logging and checks SDK version.
   * After calling this, use Bun.serve() with app.fetch to start the server.
   *
   * @example
   * ```typescript
   * const app = new MyAppServer({ ... })
   * await app.start()
   *
   * Bun.serve({
   *   port: 3333,
   *   routes: { "/*": indexHtml },
   *   fetch: app.fetch,
   * })
   * ```
   *
   * @returns Promise that resolves when initialization is complete
   */
  public async start(): Promise<void> {
    this.logger.info(`App server running on port ${this.config.port}`);

    // Check for SDK updates (non-blocking)
    await this.checkSDKVersion();
  }

  /**
   * Check and log SDK version (dist-tag aware).
   * Hits npm registry directly — no dependency on our backend.
   */
  private async checkSDKVersion(): Promise<void> {
    try {
      const sdkPkgPath = path.resolve(process.cwd(), "node_modules/@mentra/sdk/package.json");

      let currentVersion = "unknown";

      if (fs.existsSync(sdkPkgPath)) {
        const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf-8"));
        currentVersion = sdkPkg.version || "not-found";
      } else {
        this.logger.debug({ sdkPkgPath }, "No @mentra/sdk package.json found at path");
      }

      // Determine which dist-tag (release track) the dev is on
      const distTag = getDistTag(currentVersion);

      // Fetch latest version for this track directly from npm registry
      let latest: string | null = null;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const response = await fetch(`https://registry.npmjs.org/@mentra/sdk/${distTag}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          const data = (await response.json()) as { version: string };
          latest = data.version;
        }
      } catch {
        this.logger.debug("Failed to check npm for SDK updates — skipping (offline or timeout)");
      }

      if (currentVersion === "not-found") {
        this.logger.warn(
          "@mentra/sdk not found in your project dependencies. Install it with: bun install @mentra/sdk",
        );
      } else if (latest && latest !== currentVersion) {
        this.logger.warn(`SDK update available: ${currentVersion} → ${latest} — bun install @mentra/sdk@${distTag}`);
      }
    } catch (err) {
      this.logger.debug(err, "Version check failed");
    }
  }

  /**
   * Stop the Server
   * Gracefully shuts down the server and cleans up all sessions.
   */
  public async stop(): Promise<void> {
    this.logger.info("Shutting down...");
    await this.cleanup();
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
   * Add Cleanup Handler
   * Register a function to be called during server shutdown.
   *
   * @param handler - Function to call during cleanup
   */
  protected addCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.push(handler);
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

  /**
   * Setup Webhook Endpoint
   * Creates the webhook endpoint that MentraOS Cloud calls to start new sessions.
   */
  private setupWebhook(): void {
    const webhookPath = this.config.webhookPath || "/webhook";

    this.post(webhookPath, async (c) => {
      try {
        const webhookRequest = (await c.req.json()) as WebhookRequest;

        // Handle session request
        if (webhookRequest.type === WebhookRequestType.SESSION_REQUEST) {
          return this.handleSessionRequest(webhookRequest as SessionWebhookRequest, c);
        }
        // Handle stop request
        else if (webhookRequest.type === WebhookRequestType.STOP_REQUEST) {
          return this.handleStopRequest(webhookRequest as StopWebhookRequest, c);
        }
        // Unknown webhook type
        else {
          this.logger.error("Unknown webhook request type");
          return c.json(
            {
              status: "error",
              message: "Unknown webhook request type",
            } as WebhookResponse,
            400,
          );
        }
      } catch (error) {
        this.logger.error(error, "Error handling webhook");
        return c.json(
          {
            status: "error",
            message: "Error handling webhook: " + (error as Error).message,
          } as WebhookResponse,
          500,
        );
      }
    });
  }

  /**
   * Setup Tool Call Endpoint
   * Creates a /tool endpoint for handling tool calls from MentraOS Cloud.
   */
  private setupToolCallEndpoint(): void {
    this.post("/tool", async (c) => {
      try {
        const toolCall = (await c.req.json()) as ToolCall;
        if (this.activeSessionsByUserId.has(toolCall.userId)) {
          toolCall.activeSession = this.activeSessionsByUserId.get(toolCall.userId) || null;
        } else {
          toolCall.activeSession = null;
        }
        this.logger.debug({ toolId: toolCall.toolId }, "Tool call received");

        // Call the onToolCall handler and get the response
        const response = await this.onToolCall(toolCall);

        // Send back the response if one was provided
        if (response !== undefined) {
          return c.json({ status: "success", reply: response });
        } else {
          return c.json({ status: "success", reply: null });
        }
      } catch (error) {
        this.logger.error(error, "Error handling tool call");
        return c.json(
          {
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error occurred calling tool",
          },
          500,
        );
      }
    });

    this.get("/tool", async (c) => {
      return c.json({ status: "success", reply: "Hello, world!" });
    });
  }

  /**
   * Handle a session request webhook
   */
  private async handleSessionRequest(
    request: SessionWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    const { sessionId, userId, mentraOSWebsocketUrl, augmentOSWebsocketUrl } = request;
    this.logger.debug({ userId, sessionId }, "Session request received");

    // Check for existing session (user might be switching clouds)
    // If an existing session exists, we need to clean it up properly to avoid:
    // 1. Orphaned sessions with open WebSockets
    // 2. Cleanup handlers that corrupt the new session's map entries
    // See: cloud/issues/018-app-disconnect-resurrection
    const existingSession = this.activeSessions.get(sessionId);
    if (existingSession) {
      this.logger.debug({ sessionId, userId }, "Existing session found — releasing ownership before reconnect");

      try {
        // Send OWNERSHIP_RELEASE to tell the old cloud not to resurrect this app
        // The old cloud will mark the app as DORMANT instead of trying to restart it
        await existingSession.releaseOwnership("switching_clouds");
      } catch (error) {
        this.logger.warn({ error, sessionId }, "Failed to release ownership on old session — continuing");
      }

      try {
        // Disconnect the old session explicitly
        existingSession.disconnect();
      } catch (error) {
        this.logger.warn({ error, sessionId }, "Failed to disconnect old session — continuing");
      }

      // Remove from maps immediately (don't wait for cleanup handler)
      this.activeSessions.delete(sessionId);
      this.activeSessionsByUserId.delete(userId);

      this.logger.debug({ sessionId, userId }, "Old session cleaned up, proceeding with new connection");
    }

    // Create new App session
    const session = new AppSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      mentraOSWebsocketUrl: mentraOSWebsocketUrl || augmentOSWebsocketUrl,
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
        this.logger.debug({ sessionId }, `Session disconnected: ${info}`);
        reason = info;
        // String-only disconnects are typically temporary (e.g., "WebSocket closed")
        isPermanent = false;
      } else {
        this.logger.debug({ sessionId, code: info.code }, `Session disconnected: ${info.message}`);
        reason = info.reason || info.message;

        if (info.sessionEnded === true) {
          this.logger.debug({ sessionId }, "User session ended, calling onStop");
          isPermanent = true;

          this.onStop(sessionId, userId, "User session ended").catch((error) => {
            this.logger.error(error, "Error in onStop handler for session end");
          });
        }
        // Check if this is a permanent disconnection after exhausted reconnection attempts
        else if (info.permanent === true) {
          this.logger.debug({ sessionId }, "Permanent disconnection, calling onStop");
          isPermanent = true;

          this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`).catch((error) => {
            this.logger.error(error, "Error in onStop handler for permanent disconnection");
          });
        }
        // Check if this is a clean WebSocket closure (1000/1001) that won't trigger reconnection
        // These are intentional disconnects (app shutdown, manual stop, etc.)
        // AppSession skips reconnection for these codes, so we must treat them as permanent
        // to avoid zombie sessions in activeSessions map
        else if (info.wasClean === true || info.code === 1000 || info.code === 1001) {
          this.logger.debug({ sessionId, code: info.code }, "Clean WebSocket closure, treating as permanent");
          isPermanent = true;

          // Call onStop for clean disconnects too
          this.onStop(sessionId, userId, `Clean disconnect: ${reason}`).catch((error) => {
            this.logger.error(error, "Error in onStop handler for clean disconnect");
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
          this.logger.debug({ sessionId }, "Session cleanup skipped — a newer session has taken over");
        }
        if (this.activeSessionsByUserId.get(userId) === session) {
          this.activeSessionsByUserId.delete(userId);
        }

        // Clean up any pending photo requests for this session
        this.cleanupPhotoRequestsForSession(sessionId);
      } else {
        // Temporary disconnect - session stays in maps for reconnection
        // Photo requests remain pending and can still be fulfilled
        this.logger.debug({ sessionId, reason }, "Temporary disconnect, keeping session for reconnection");
      }
    });

    const cleanupError = session.events.onError((error) => {
      this.logger.error(error, "Session error");
    });

    // Start the session
    try {
      await session.connect(sessionId);
      this.activeSessions.set(sessionId, session);
      this.activeSessionsByUserId.set(userId, session);
      await this.onSession(session, sessionId, userId);
      return c.json({ status: "success" } as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Failed to connect session");
      cleanupDisconnect();
      cleanupError();
      return c.json(
        {
          status: "error",
          message: "Failed to connect",
        } as WebhookResponse,
        500,
      );
    }
  }

  /**
   * Handle a stop request webhook
   */
  private async handleStopRequest(
    request: StopWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    const { sessionId, userId, reason } = request;
    this.logger.debug({ sessionId, userId, reason }, "Stop request received");

    try {
      await this.onStop(sessionId, userId, reason);
      return c.json({ status: "success" } as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Error handling stop request");
      return c.json(
        {
          status: "error",
          message: "Failed to process stop request",
        } as WebhookResponse,
        500,
      );
    }
  }

  /**
   * Setup Health Check Endpoint
   * Creates a /health endpoint for monitoring server status.
   */
  private setupHealthCheck(): void {
    if (this.config.healthCheck) {
      this.get("/health", (c) => {
        return c.json({
          status: "healthy",
          app: this.config.packageName,
          activeSessions: this.activeSessions.size,
        });
      });
    }
  }

  /**
   * Setup Settings Endpoint
   * Creates a /settings endpoint that the MentraOS Cloud can use to update settings.
   */
  private setupSettingsEndpoint(): void {
    this.post("/settings", async (c) => {
      try {
        const { userIdForSettings, settings } = await c.req.json();

        if (!userIdForSettings || !Array.isArray(settings)) {
          return c.json(
            {
              status: "error",
              message: "Missing userId or settings array in request body",
            },
            400,
          );
        }

        this.logger.debug({ userId: userIdForSettings }, "Settings update received");

        // Find all active sessions for this user
        const userSessions: AppSession[] = [];

        this.activeSessions.forEach((session, _sessionId) => {
          if (session.userId === userIdForSettings) {
            userSessions.push(session);
          }
        });

        if (userSessions.length === 0) {
          this.logger.debug({ userId: userIdForSettings }, "No active sessions for settings update");
        }

        // Update settings for all of the user's sessions
        for (const session of userSessions) {
          session.updateSettingsForTesting(settings);
        }

        // Allow subclasses to handle settings updates if they implement the method
        if (typeof (this as any).onSettingsUpdate === "function") {
          await (this as any).onSettingsUpdate(userIdForSettings, settings);
        }

        return c.json({
          status: "success",
          message: "Settings updated successfully",
          sessionsUpdated: userSessions.length,
        });
      } catch (error) {
        this.logger.error(error, "Error handling settings update");
        return c.json(
          {
            status: "error",
            message: "Internal server error processing settings update",
          },
          500,
        );
      }
    });
  }

  /**
   * Setup Static File Serving
   * Configures Hono to serve static files from the specified directory.
   */
  private setupPublicDir(): void {
    if (this.config.publicDir) {
      const publicPath = path.resolve(this.config.publicDir);
      this.use("/*", serveStatic({ root: publicPath }));
      this.logger.debug({ publicPath }, "Serving static files");
    }
  }

  /**
   * Setup Shutdown Handlers
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
    this.logger.debug("Cleanup started — not releasing ownership (cloud will resurrect)");
    // Close all active sessions WITHOUT releasing ownership
    // This allows the cloud to resurrect apps when we come back up
    for (const [sessionId, session] of this.activeSessions) {
      this.logger.debug({ sessionId }, "Closing session");
      try {
        // Just disconnect, don't release ownership
        // The cloud will enter grace period and then resurrect via webhook
        await session.disconnect({
          releaseOwnership: false,
        });
      } catch (error) {
        this.logger.error(error, `Error during cleanup of session ${sessionId}`);
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
    this.post("/photo-upload", async (c) => {
      try {
        // Parse multipart form data
        const body = await c.req.parseBody();
        const requestId = body.requestId as string;
        const type = body.type as string;
        const errorCode = body.errorCode as string;
        const errorMessage = body.errorMessage as string;
        const photoFile = body.photo as File | undefined;

        // Defensive parsing: photo file presence is the primary success indicator
        // The success field may be undefined/missing from some clients
        const hasPhotoFile = !!photoFile;
        const successValue = typeof body.success === "string" ? body.success : undefined;
        const isExplicitError = type === "photo_error" || successValue === "false";

        this.logger.debug({ requestId, type, hasPhotoFile, isExplicitError }, "Photo response received");

        if (!requestId) {
          this.logger.error("No requestId in photo response");
          return c.json({ success: false, error: "No requestId provided" }, 400);
        }

        // Complete the request (O(1) lookup and cleanup)
        const pending = this.completePhotoRequest(requestId);
        if (!pending) {
          this.logger.debug(
            { requestId, pendingCount: this.pendingPhotoRequests.size },
            "No pending request found for photo (may have timed out or session ended)",
          );
          return c.json(
            { success: false, error: "No pending request found for this photo (may have timed out or session ended)" },
            404,
          );
        }

        // Handle error response: only if explicitly marked as error AND no photo file
        if (isExplicitError && !hasPhotoFile) {
          this.logger.warn(
            { requestId, errorCode, errorMessage },
            `Photo capture failed: ${errorCode} - ${errorMessage}`,
          );
          pending.reject(new Error(`${errorCode || "UNKNOWN_ERROR"}: ${errorMessage || "Unknown error"}`));

          return c.json({
            success: true,
            requestId,
            message: "Photo error received successfully",
          });
        }

        // Handle successful photo upload
        if (!photoFile) {
          const errorMsg = "No photo file in upload (and no explicit error reported)";
          this.logger.error({ requestId, bodyKeys: Object.keys(body) }, errorMsg);
          pending.reject(new Error(errorMsg));
          return c.json({ success: false, error: errorMsg }, 400);
        }

        // Read file buffer
        const buffer = Buffer.from(await photoFile.arrayBuffer());

        this.logger.debug({ requestId, size: photoFile.size }, "Photo received");

        // Deliver photo data to the original requester
        pending.resolve({
          buffer,
          mimeType: photoFile.type,
          filename: photoFile.name || "photo.jpg",
          requestId,
          size: photoFile.size,
          timestamp: new Date(),
        });

        return c.json({
          success: true,
          requestId,
          message: "Photo received successfully",
        });
      } catch (error) {
        this.logger.error(error, "Error handling photo response");
        return c.json({ success: false, error: "Internal server error processing photo response" }, 500);
      }
    });
  }

  /**
   * Setup Mentra Auth Redirect Endpoint
   * Creates a /mentra-auth endpoint that redirects to the MentraOS OAuth flow.
   */
  private setupMentraAuthRedirect(): void {
    this.get("/mentra-auth", (c) => {
      const authUrl = `https://account.mentra.glass/auth?packagename=${encodeURIComponent(this.config.packageName)}`;
      return c.redirect(authUrl, 302);
    });
  }
}

/**
 * @deprecated Use `AppServerConfig` instead. `TpaServerConfig` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 */
export type TpaServerConfig = AppServerConfig;

/**
 * @deprecated Use `AppServer` instead. `TpaServer` is deprecated and will be removed in a future version.
 * This is an alias for backward compatibility only.
 */
export class TpaServer extends AppServer {
  constructor(config: TpaServerConfig) {
    super(config);
    console.warn(
      "⚠️  DEPRECATION WARNING: TpaServer is deprecated and will be removed in a future version. " +
        "Please use AppServer instead. " +
        'Simply replace "TpaServer" with "AppServer" in your code.',
    );
  }
}
