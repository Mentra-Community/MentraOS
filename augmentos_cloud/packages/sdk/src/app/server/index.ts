/**
 * 🚀 App Server Module
 *
 * Creates and manages a server for Apps in the MentraOS ecosystem.
 * Handles webhook endpoints, session management, and cleanup.
 */
import express, { type Express } from 'express';
import path from 'path';
import { AppSession } from '../session/index';
import { createAuthMiddleware } from '../webview';
import {
  WebhookRequest,
  WebhookRequestType,
  WebhookResponse,
  SessionWebhookRequest,
  StopWebhookRequest,
  isSessionWebhookRequest,
  isStopWebhookRequest,
  ToolCall
} from '../../types';
import { Logger } from 'pino';
import { logger as rootLogger } from '../../logging/logger';
import axios from 'axios';

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
  /** Array of cleanup handlers to run on shutdown */
  private cleanupHandlers: Array<() => void> = [];
  /** App instructions string shown to the user */
  private appInstructions: string | null = null;

  public readonly logger: Logger;

  constructor(private config: AppServerConfig) {
    // Set defaults and merge with provided config
    this.config = {
      port: 7010,
      webhookPath: '/webhook',
      publicDir: false,
      healthCheck: true,
      ...config
    };

    this.logger = rootLogger.child({ app: this.config.packageName, packageName: this.config.packageName, service: 'app-server' });

    // Initialize Express app
    this.app = express();
    this.app.use(express.json());

    const cookieParser = require('cookie-parser');
    this.app.use(cookieParser(this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`));

    // Apply authentication middleware
    this.app.use(createAuthMiddleware({
      apiKey: this.config.apiKey,
      packageName: this.config.packageName,
      cookieSecret: this.config.cookieSecret || `AOS_${this.config.packageName}_${this.config.apiKey.substring(0, 8)}`
    }));

    this.appInstructions = (config as any).appInstructions || null;

    // Setup server features
    this.setupWebhook();
    this.setupSettingsEndpoint();
    this.setupHealthCheck();
    this.setupToolCallEndpoint();
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
    this.logger.info(`🚀 Starting new session handling for session ${sessionId} and user ${userId}`);
    // Core session handling logic (onboarding removed)
    this.logger.info(`✅ Session handling completed for session ${sessionId} and user ${userId}`);
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
      this.app.listen(this.config.port, () => {
        this.logger.info(`🎯 App server running at http://localhost:${this.config.port}`);
        if (this.config.publicDir) {
          this.logger.info(`📂 Serving static files from ${this.config.publicDir}`);
        }
        resolve();
      });
    });
  }

  /**
   * 🛑 Stop the Server
   * Gracefully shuts down the server and cleans up all sessions.
   */
  public stop(): void {
    this.logger.info('\n🛑 Shutting down...');
    this.cleanup();
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
  protected generateToken(
    userId: string,
    sessionId: string,
    secretKey: string
  ): string {
    const { createToken } = require('../token/utils');
    return createToken(
      {
        userId,
        packageName: this.config.packageName,
        sessionId
      },
      { secretKey }
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
      this.logger.error('❌ Webhook path not set');
      throw new Error('Webhook path not set');
    }

    this.app.post(this.config.webhookPath, async (req, res) => {
      try {
        const webhookRequest = req.body as WebhookRequest;

        // Handle session request
        if (isSessionWebhookRequest(webhookRequest)) {
          await this.handleSessionRequest(webhookRequest, res);
        }
        // Handle stop request
        else if (isStopWebhookRequest(webhookRequest)) {
          await this.handleStopRequest(webhookRequest, res);
        }
        // Unknown webhook type
        else {
          this.logger.error('❌ Unknown webhook request type');
          res.status(400).json({
            status: 'error',
            message: 'Unknown webhook request type'
          } as WebhookResponse);
        }
      } catch (error) {
        this.logger.error(error, '❌ Error handling webhook: ' + (error as Error).message);
        res.status(500).json({
          status: 'error',
          message: 'Error handling webhook: ' + (error as Error).message
        } as WebhookResponse);
      }
    });
  }

  /**
   * 🛠️ Setup Tool Call Endpoint
   * Creates a /tool endpoint for handling tool calls from MentraOS Cloud.
   */
  private setupToolCallEndpoint(): void {
    this.app.post('/tool', async (req, res) => {
      try {
        const toolCall = req.body as ToolCall;
        this.logger.info({ body: req.body }, `🔧 Received tool call: ${toolCall.toolId}`);
        // Call the onToolCall handler and get the response
        const response = await this.onToolCall(toolCall);

        // Send back the response if one was provided
        if (response !== undefined) {
          res.json({ status: 'success', reply: response });
        } else {
          res.json({ status: 'success', reply: null });
        }
      } catch (error) {
        this.logger.error(error, '❌ Error handling tool call:');
        res.status(500).json({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error occurred calling tool'
        });
      }
    });
    this.app.get('/tool', async (req, res) => {
      res.json({ status: 'success', reply: 'Hello, world!' });
    });
  }

  /**
   * Handle a session request webhook
   */
  private async handleSessionRequest(request: SessionWebhookRequest, res: express.Response): Promise<void> {
    const { sessionId, userId, mentraOSWebsocketUrl, augmentOSWebsocketUrl } = request;
    this.logger.info({userId}, `🗣️ Received session request for user ${userId}, session ${sessionId}\n\n`);

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
      // Handle different disconnect info formats (string or object)
      if (typeof info === 'string') {
        this.logger.info(`👋 Session ${sessionId} disconnected: ${info}`);
      } else {
        // It's an object with detailed disconnect information
        this.logger.info(`👋 Session ${sessionId} disconnected: ${info.message} (code: ${info.code}, reason: ${info.reason})`);

        // Check if this is a permanent disconnection after exhausted reconnection attempts
        if (info.permanent === true) {
          this.logger.info(`🛑 Permanent disconnection detected for session ${sessionId}, calling onStop`);

          // Keep track of the original session before removal
          const session = this.activeSessions.get(sessionId);

          // Call onStop with a reconnection failure reason
          this.onStop(sessionId, userId, `Connection permanently lost: ${info.reason}`).catch(error => {
            this.logger.error(error, `❌ Error in onStop handler for permanent disconnection:`);
          });
        }
      }

      // Remove the session from active sessions in all cases
      this.activeSessions.delete(sessionId);
    });

    const cleanupError = session.events.onError((error) => {
      this.logger.error(error, `❌ [Session ${sessionId}] Error:`);
    });

    // Start the session
    try {
      await session.connect(sessionId);
      this.activeSessions.set(sessionId, session);
      await this.onSession(session, sessionId, userId);
      res.status(200).json({ status: 'success' } as WebhookResponse);
    } catch (error) {
      this.logger.error(error, '❌ Failed to connect:');
      cleanupDisconnect();
      cleanupError();
      res.status(500).json({
        status: 'error',
        message: 'Failed to connect'
      } as WebhookResponse);
    }
  }

  /**
   * Handle a stop request webhook
   */
  private async handleStopRequest(request: StopWebhookRequest, res: express.Response): Promise<void> {
    const { sessionId, userId, reason } = request;
    this.logger.info(`\n\n🛑 Received stop request for user ${userId}, session ${sessionId}, reason: ${reason}\n\n`);

    try {
      await this.onStop(sessionId, userId, reason);
      res.status(200).json({ status: 'success' } as WebhookResponse);
    } catch (error) {
      this.logger.error(error, '❌ Error handling stop request:');
      res.status(500).json({
        status: 'error',
        message: 'Failed to process stop request'
      } as WebhookResponse);
    }
  }

  /**
   * ❤️ Setup Health Check Endpoint
   * Creates a /health endpoint for monitoring server status.
   */
  private setupHealthCheck(): void {
    if (this.config.healthCheck) {
      this.app.get('/health', (req, res) => {
        res.json({
          status: 'healthy',
          app: this.config.packageName,
          activeSessions: this.activeSessions.size
        });
      });
    }
  }

  /**
   * ⚙️ Setup Settings Endpoint
   * Creates a /settings endpoint that the MentraOS Cloud can use to update settings.
   */
  private setupSettingsEndpoint(): void {
    this.app.post('/settings', async (req, res) => {
      try {
        const { userIdForSettings, settings } = req.body;

        if (!userIdForSettings || !Array.isArray(settings)) {
          return res.status(400).json({
            status: 'error',
            message: 'Missing userId or settings array in request body'
          });
        }

        this.logger.info(`⚙️ Received settings update for user ${userIdForSettings}`);

        // Find all active sessions for this user
        const userSessions: AppSession[] = [];

        // Look through all active sessions
        this.activeSessions.forEach((session, sessionId) => {
          // Check if the session has this userId (not directly accessible)
          // We're relying on the webhook handler to have already verified this
          if (sessionId.includes(userIdForSettings)) {
            userSessions.push(session);
          }
        });

        if (userSessions.length === 0) {
          this.logger.warn(`⚠️ No active sessions found for user ${userIdForSettings}`);
        } else {
          this.logger.info(`🔄 Updating settings for ${userSessions.length} active sessions`);
        }

        // Update settings for all of the user's sessions
        for (const session of userSessions) {
          session.updateSettingsForTesting(settings);
        }

        // Allow subclasses to handle settings updates if they implement the method
        if (typeof (this as any).onSettingsUpdate === 'function') {
          await (this as any).onSettingsUpdate(userIdForSettings, settings);
        }

        res.json({
          status: 'success',
          message: 'Settings updated successfully',
          sessionsUpdated: userSessions.length
        });
      } catch (error) {
        this.logger.error(error, '❌ Error handling settings update:');
        res.status(500).json({
          status: 'error',
          message: 'Internal server error processing settings update'
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
      this.logger.info(`📂 Serving static files from ${publicPath}`);
    }
  }

  /**
   * 🛑 Setup Shutdown Handlers
   * Registers process signal handlers for graceful shutdown.
   */
  private setupShutdown(): void {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  /**
   * 🧹 Cleanup
   * Closes all active sessions and runs cleanup handlers.
   */
  private cleanup(): void {
    // Close all active sessions
    for (const [sessionId, session] of this.activeSessions) {
      this.logger.info(`👋 Closing session ${sessionId}`);
      session.disconnect();
    }
    this.activeSessions.clear();

    // Run cleanup handlers
    this.cleanupHandlers.forEach(handler => handler());
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
      '⚠️  DEPRECATION WARNING: TpaServer is deprecated and will be removed in a future version. ' +
      'Please use AppServer instead. ' +
      'Simply replace "TpaServer" with "AppServer" in your code.'
    );
  }
}
