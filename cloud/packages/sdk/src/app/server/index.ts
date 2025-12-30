/**
 * 🚀 App Server Module
 *
 * Creates and manages a server for Apps in the MentraOS ecosystem.
 * Handles webhook endpoints, session management, and cleanup.
 */
import express, {type Express} from "express"
import path from "path"
import fs from "fs"
import {AppSession} from "../session/index"
import {createAuthMiddleware} from "../webview"
import {newSDKUpdate} from "../../constants/log-messages/updates"

import {
  WebhookRequest,
  WebhookResponse,
  SessionWebhookRequest,
  StopWebhookRequest,
  ToolCall,
  WebhookRequestType,
} from "../../types"

import {Logger} from "pino"
import {logger as rootLogger} from "../../logging/logger"
import axios from "axios"

export const GIVE_APP_CONTROL_OF_TOOL_RESPONSE: string = "GIVE_APP_CONTROL_OF_TOOL_RESPONSE"

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
  packageName: string
  /** 🔑 API key for authentication with MentraOS Cloud */
  apiKey: string
  /** 🌐 Port number for the server (default: 7010) */
  port?: number

  /** Cloud API URL (default: 'api.mentra.glass') */
  cloudApiUrl?: string

  /** 🛣️ [DEPRECATED] do not set: The SDK will automatically expose an endpoint at '/webhook' */
  webhookPath?: string
  /**
   * 📂 Directory for serving static files (e.g., images, logos)
   * Set to false to disable static file serving
   */
  publicDir?: string | false

  /** ❤️ Enable health check endpoint at /health (default: true) */
  healthCheck?: boolean
  /**
   * 🔐 Secret key used to sign session cookies
   * This must be a strong, unique secret
   */
  cookieSecret?: string
  /** App instructions string shown to the user */
  appInstructions?: string
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
  private app: Express
  /** Map of active user sessions by sessionId */
  private activeSessions = new Map<string, AppSession>()
  /** Map of active user sessions by userId */
  private activeSessionsByUserId = new Map<string, AppSession>()
  /** Array of cleanup handlers to run on shutdown */
  private cleanupHandlers: Array<() => void> = []
  /** App instructions string shown to the user */
  private appInstructions: string | null = null

  public readonly logger: Logger

  constructor(private config: AppServerConfig) {
    // Set defaults and merge with provided config
    this.config = {
      port: 7010,
      webhookPath: "/webhook",
      publicDir: false,
      healthCheck: true,
      ...config,
    }

    this.logger = rootLogger.child({
      app: this.config.packageName,
      packageName: this.config.packageName,
      service: "app-server",
    })

    // Initialize Express app
    this.app = express()
    this.app.use(express.json())

    const cookieParser = require("cookie-parser")
    this.app.use(
      cookieParser(this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`),
    )

    // Apply authentication middleware
    this.app.use(
      createAuthMiddleware({
        apiKey: this.config.apiKey,
        packageName: this.config.packageName,
        getAppSessionForUser: (userId: string) => {
          return this.activeSessionsByUserId.get(userId) || null
        },
        cookieSecret:
          this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`,
      }) as any,
    )

    this.appInstructions = (config as any).appInstructions || null

    // Setup server features
    this.setupWebhook()
    this.setupSettingsEndpoint()
    this.setupHealthCheck()
    this.setupToolCallEndpoint()
    this.setupPhotoUploadEndpoint()
    this.setupMentraAuthRedirect()
    this.setupPublicDir()
    this.setupShutdown()
  }

  // Expose Express app for custom routes.
  // This is useful for adding custom API routes or middleware.
  public getExpressApp(): Express {
    return this.app
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
    this.logger.info(`🚀 Starting new session handling for session ${sessionId} and user ${userId}`)
    // Core session handling logic (onboarding removed)
    this.logger.info(`✅ Session handling completed for session ${sessionId} and user ${userId}`)
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
    this.logger.debug(`Session ${sessionId} stopped for user ${userId}. Reason: ${reason}`)

    // Default implementation: close the session if it exists
    const session = this.activeSessions.get(sessionId)
    if (session) {
      session.disconnect()
      this.activeSessions.delete(sessionId)
      this.activeSessionsByUserId.delete(userId)
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
    this.logger.debug(`Tool call received: ${toolCall.toolId}`)
    this.logger.debug(`Parameters: ${JSON.stringify(toolCall.toolParameters)}`)
    return undefined
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
        this.logger.info(`🎯 App server running at http://localhost:${this.config.port}`)
        if (this.config.publicDir) {
          this.logger.info(`📂 Serving static files from ${this.config.publicDir}`)
        }

        // 🔑 Grab SDK version
        try {
          // Look for the actual installed @mentra/sdk package.json in node_modules
          const sdkPkgPath = path.resolve(process.cwd(), "node_modules/@mentra/sdk/package.json")

          let currentVersion = "unknown"

          if (fs.existsSync(sdkPkgPath)) {
            const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, "utf-8"))

            // Get the actual installed version
            currentVersion = sdkPkg.version || "not-found" // located in the node module
          } else {
            this.logger.debug({sdkPkgPath}, "No @mentra/sdk package.json found at path")
          }

          // this.logger.debug(`Developer is using SDK version: ${currentVersion}`);

          // Fetch latest SDK version from the API endpoint
          let latest: string | null = null
          try {
            const cloudHost = "api.mentra.glass"
            const response = await axios.get(
              `https://${cloudHost}/api/sdk/version`,
              {timeout: 3000}, // 3 second timeout
            )
            if (response.data && response.data.success && response.data.data) {
              latest = response.data.data.latest
            }
          } catch {
            this.logger.debug(
              "Failed to fetch latest SDK version - skipping version check (offline or API unavailable)",
            )
          }

          if (currentVersion === "not-found") {
            this.logger.warn(
              `⚠️ @mentra/sdk not found in your project dependencies. Please install it with: npm install @mentra/sdk`,
            )
          } else if (latest && latest !== currentVersion) {
            this.logger.warn(newSDKUpdate(latest))
          }
        } catch (err) {
          this.logger.error(err, "Version check failed")
        }

        resolve()
      })
    })
  }

  /**
   * 🛑 Stop the Server
   * Gracefully shuts down the server and cleans up all sessions.
   */
  public async stop(): Promise<void> {
    this.logger.info("\n🛑 Shutting down...")
    await this.cleanup()
    process.exit(0)
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
    const {createToken} = require("../token/utils")
    return createToken(
      {
        userId,
        packageName: this.config.packageName,
        sessionId,
      },
      {secretKey},
    )
  }

  /**
   * 🧹 Add Cleanup Handler
   * Register a function to be called during server shutdown.
   *
   * @param handler - Function to call during cleanup
   */
  protected addCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.push(handler)
  }

  /**
   * 🎯 Setup Webhook Endpoint
   * Creates the webhook endpoint that MentraOS Cloud calls to start new sessions.
   */
  private setupWebhook(): void {
    if (!this.config.webhookPath) {
      this.logger.error("❌ Webhook path not set")
      throw new Error("Webhook path not set")
    }

    this.app.post(this.config.webhookPath, async (req, res) => {
      try {
        const webhookRequest = req.body as WebhookRequest

        // Handle session request
        if (webhookRequest.type === WebhookRequestType.SESSION_REQUEST) {
          await this.handleSessionRequest(webhookRequest, res)
        }
        // Handle stop request
        else if (webhookRequest.type === WebhookRequestType.STOP_REQUEST) {
          await this.handleStopRequest(webhookRequest, res)
        }
        // Unknown webhook type
        else {
          this.logger.error("❌ Unknown webhook request type")
          res.status(400).json({
            status: "error",
            message: "Unknown webhook request type",
          } as WebhookResponse)
        }
      } catch (error) {
        this.logger.error(error, "❌ Error handling webhook: " + (error as Error).message)
        res.status(500).json({
          status: "error",
          message: "Error handling webhook: " + (error as Error).message,
        } as WebhookResponse)
      }
    })
  }

  /**
   * 🛠️ Setup Tool Call Endpoint
   * Creates a /tool endpoint for handling tool calls from MentraOS Cloud.
   */
  private setupToolCallEndpoint(): void {
    this.app.post("/tool", async (req, res) => {
      try {
        const toolCall = req.body as ToolCall
        if (this.activeSessionsByUserId.has(toolCall.userId)) {
          toolCall.activeSession = this.activeSessionsByUserId.get(toolCall.userId) || null
        } else {
          toolCall.activeSession = null
        }
        this.logger.info({body: req.body}, `🔧 Received tool call: ${toolCall.toolId}`)
        // Call the onToolCall handler and get the response
        const response = await this.onToolCall(toolCall)

        // Send back the response if one was provided
        if (response !== undefined) {
          res.json({status: "success", reply: response})
        } else {
          res.json({status: "success", reply: null})
        }
      } catch (error) {
        this.logger.error(error, "❌ Error handling tool call:")
        res.status(500).json({
          status: "error",
          message: error instanceof Error ? error.message : "Unknown error occurred calling tool",
        })
      }
    })
    this.app.get("/tool", async (req, res) => {
      res.json({status: "success", reply: "Hello, world!"})
    })
  }

  /**
   * Handle a session request webhook
   */
  private async handleSessionRequest(request: SessionWebhookRequest, res: express.Response): Promise<void> {
    const {sessionId, userId, mentraOSWebsocketUrl, augmentOSWebsocketUrl} = request
    this.logger.info({userId}, `🗣️ Received session request for user ${userId}, session ${sessionId}\n\n`)

    // Create new App session
    const session = new AppSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      mentraOSWebsocketUrl: mentraOSWebsocketUrl || augmentOSWebsocketUrl, // The websocket URL for the specific MentraOS server that this userSession is connecting to.
      appServer: this,
      userId,
    })

    // Setup session event handlers
    const cleanupDisconnect = session.events.onDisconnected((info) => {
      // Handle different disconnect info formats (string or object)
      if (typeof info === "string") {
        this.logger.info(`👋 Session ${sessionId} disconnected: ${info}`)
      } else {
        // It's an object with detailed disconnect information
        this.logger.info(
          `👋 Session ${sessionId} disconnected: ${info.message} (code: ${info.code}, reason: ${info.reason})`,
        )

        // Check if this is a user session end event
        // This happens when the UserSession is disposed after 1 minute grace period
        if (info.sessionEnded === true) {
          this.logger.info(`🛑 User session ended for session ${sessionId}, calling onStop`)

          // Call onStop with session end reason
          // This allows apps to clean up resources when the user's session ends
          this.onStop(sessionId, userId, "User session ended").catch((error) => {
            this.logger.error(error, `❌ Error in onStop handler for session end:`)
          })
        }
        // Check if this is a permanent disconnection after exhausted reconnection attempts
        else if (info.permanent === true) {
          this.logger.info(`🛑 Permanent disconnection detected for session ${sessionId}, calling onStop`)

          // Keep track of the original session before removal
          // const session = this.activeSessions.get(sessionId);
          const _session = this.activeSessions.get(sessionId)

          // Call onStop with a reconnection failure reason
          this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`).catch((error) => {
            this.logger.error(error, `❌ Error in onStop handler for permanent disconnection:`)
          })
        }
      }

      // Remove the session from active sessions in all cases
      this.activeSessions.delete(sessionId)
      this.activeSessionsByUserId.delete(userId)
    })

    const cleanupError = session.events.onError((error) => {
      this.logger.error(error, `❌ [Session ${sessionId}] Error:`)
    })

    // Start the session
    try {
      await session.connect(sessionId)
      this.activeSessions.set(sessionId, session)
      this.activeSessionsByUserId.set(userId, session)
      await this.onSession(session, sessionId, userId)
      res.status(200).json({status: "success"} as WebhookResponse)
    } catch (error) {
      this.logger.error(error, "❌ Failed to connect:")
      cleanupDisconnect()
      cleanupError()
      res.status(500).json({
        status: "error",
        message: "Failed to connect",
      } as WebhookResponse)
    }
  }

  /**
   * Handle a stop request webhook
   */
  private async handleStopRequest(request: StopWebhookRequest, res: express.Response): Promise<void> {
    const {sessionId, userId, reason} = request
    this.logger.info(`\n\n🛑 Received stop request for user ${userId}, session ${sessionId}, reason: ${reason}\n\n`)

    try {
      await this.onStop(sessionId, userId, reason)
      res.status(200).json({status: "success"} as WebhookResponse)
    } catch (error) {
      this.logger.error(error, "❌ Error handling stop request:")
      res.status(500).json({
        status: "error",
        message: "Failed to process stop request",
      } as WebhookResponse)
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
        })
      })
    }
  }

  /**
   * ⚙️ Setup Settings Endpoint
   * Creates a /settings endpoint that the MentraOS Cloud can use to update settings.
   */
  private setupSettingsEndpoint(): void {
    this.app.post("/settings", async (req, res) => {
      try {
        const {userIdForSettings, settings} = req.body

        if (!userIdForSettings || !Array.isArray(settings)) {
          return res.status(400).json({
            status: "error",
            message: "Missing userId or settings array in request body",
          })
        }

        this.logger.info(`⚙️ Received settings update for user ${userIdForSettings}`)

        // Find all active sessions for this user
        const userSessions: AppSession[] = []

        // Look through all active sessions
        this.activeSessions.forEach((session, _sessionId) => {
          // Check if the session has this userId (not directly accessible)
          // We're relying on the webhook handler to have already verified this
          if (session.userId === userIdForSettings) {
            userSessions.push(session)
          }
        })

        if (userSessions.length === 0) {
          this.logger.warn(`⚠️ No active sessions found for user ${userIdForSettings}`)
        } else {
          this.logger.info(`🔄 Updating settings for ${userSessions.length} active sessions`)
        }

        // Update settings for all of the user's sessions
        for (const session of userSessions) {
          session.updateSettingsForTesting(settings)
        }

        // Allow subclasses to handle settings updates if they implement the method
        if (typeof (this as any).onSettingsUpdate === "function") {
          await (this as any).onSettingsUpdate(userIdForSettings, settings)
        }

        res.json({
          status: "success",
          message: "Settings updated successfully",
          sessionsUpdated: userSessions.length,
        })
      } catch (error) {
        this.logger.error(error, "❌ Error handling settings update:")
        res.status(500).json({
          status: "error",
          message: "Internal server error processing settings update",
        })
      }
    })
  }

  /**
   * 📂 Setup Static File Serving
   * Configures Express to serve static files from the specified directory.
   */
  private setupPublicDir(): void {
    if (this.config.publicDir) {
      const publicPath = path.resolve(this.config.publicDir)
      this.app.use(express.static(publicPath))
      this.logger.info(`📂 Serving static files from ${publicPath}`)
    }
  }

  /**
   * 🛑 Setup Shutdown Handlers
   * Registers process signal handlers for graceful shutdown.
   */
  private setupShutdown(): void {
    process.on("SIGTERM", () => this.stop())
    process.on("SIGINT", () => this.stop())
  }

  /**
   * 🧹 Cleanup
   * Closes all active sessions and runs cleanup handlers.
   * Releases ownership before disconnecting to enable clean handoffs (no resurrection).
   */
  private async cleanup(): Promise<void> {
    // Close all active sessions with ownership release for clean handoff
    for (const [sessionId, session] of this.activeSessions) {
      this.logger.info(`👋 Closing session ${sessionId} with ownership release`)
      try {
        // Release ownership first, then disconnect
        // This tells the cloud not to resurrect this app
        await session.disconnect({
          releaseOwnership: true,
          reason: "clean_shutdown",
        })
      } catch (error) {
        this.logger.error(error, `Error during cleanup of session ${sessionId}`)
        // Still try to disconnect even if release fails
        try {
          await session.disconnect()
        } catch {
          // Ignore secondary errors
        }
      }
    }
    this.activeSessions.clear()
    this.activeSessionsByUserId.clear()

    // Run cleanup handlers
    this.cleanupHandlers.forEach((handler) => handler())
  }

  /**
   * 🎯 Setup Photo Upload Endpoint
   * Creates a /photo-upload endpoint for receiving photos directly from ASG glasses
   */
  private setupPhotoUploadEndpoint(): void {
    const multer = require("multer")

    // Configure multer for handling multipart form data
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
      },
      fileFilter: (req: any, file: any, cb: any) => {
        // Accept image files only
        if (file.mimetype && file.mimetype.startsWith("image/")) {
          cb(null, true)
        } else {
          cb(new Error("Only image files are allowed"), false)
        }
      },
    })

    this.app.post("/photo-upload", upload.single("photo"), async (req: any, res: any) => {
      try {
        const {requestId, type, success, errorCode, errorMessage} = req.body
        const photoFile = req.file

        console.log("Received photo response: ", req.body)

        this.logger.info(
          {requestId, type, success, errorCode},
          `📸 Received photo response: ${requestId} (type: ${type})`,
        )

        if (!requestId) {
          this.logger.error("No requestId in photo response")
          return res.status(400).json({
            success: false,
            error: "No requestId provided",
          })
        }

        // Find the corresponding session that made this photo request
        const session = this.findSessionByPhotoRequestId(requestId)
        if (!session) {
          this.logger.warn({requestId}, "No active session found for photo request")
          return res.status(404).json({
            success: false,
            error: "No active session found for this photo request",
          })
        }

        // Handle error response (no photo file, but has error info)
        if (type === "photo_error" || success === false) {
          // Create error response object
          const errorResponse = {
            requestId,
            success: false as const,
            error: {
              code: errorCode || "UNKNOWN_ERROR",
              message: errorMessage || "Unknown error occurred",
            },
          }

          // Deliver error to the session (logging happens in camera module)
          session.camera.handlePhotoError(errorResponse)

          // Respond to ASG client
          return res.json({
            success: true,
            requestId,
            message: "Photo error received successfully",
          })
        }

        // Handle successful photo upload
        if (!photoFile) {
          this.logger.error({requestId}, "No photo file in successful upload")
          return res.status(400).json({
            success: false,
            error: "No photo file provided for successful upload",
          })
        }

        // Create photo data object
        const photoData = {
          buffer: photoFile.buffer,
          mimeType: photoFile.mimetype,
          filename: photoFile.originalname || "photo.jpg",
          requestId,
          size: photoFile.size,
          timestamp: new Date(),
        }

        // Deliver photo to the session
        session.camera.handlePhotoReceived(photoData)

        // Respond to ASG client
        res.json({
          success: true,
          requestId,
          message: "Photo received successfully",
        })
      } catch (error) {
        this.logger.error(error, "❌ Error handling photo response")
        res.status(500).json({
          success: false,
          error: "Internal server error processing photo response",
        })
      }
    })
  }

  /**
   * 🔐 Setup Mentra Auth Redirect Endpoint
   * Creates a /mentra-auth endpoint that redirects to the MentraOS OAuth flow.
   */
  private setupMentraAuthRedirect(): void {
    this.app.get("/mentra-auth", (req, res) => {
      // Redirect to the account.mentra.glass OAuth flow with the app's package name
      const authUrl = `https://account.mentra.glass/auth?packagename=${encodeURIComponent(this.config.packageName)}`

      this.logger.info(`🔐 Redirecting to MentraOS OAuth flow: ${authUrl}`)

      res.redirect(302, authUrl)
    })
  }

  /**
   * Find session that has a pending photo request for the given requestId
   */
  private findSessionByPhotoRequestId(requestId: string): AppSession | undefined {
    for (const [_sessionId, session] of this.activeSessions) {
      if (session.camera.hasPhotoPendingRequest(requestId)) {
        return session
      }
    }
    return undefined
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
export type TpaServerConfig = AppServerConfig

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
    super(config)
    // Emit a deprecation warning to help developers migrate
    console.warn(
      "⚠️  DEPRECATION WARNING: TpaServer is deprecated and will be removed in a future version. " +
        "Please use AppServer instead. " +
        'Simply replace "TpaServer" with "AppServer" in your code.',
    )
  }
}
