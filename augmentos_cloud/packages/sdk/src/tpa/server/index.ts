/**
 * 🚀 TPA Server Module
 * 
 * Creates and manages a server for Third Party Apps (TPAs) in the AugmentOS ecosystem.
 * Handles webhook endpoints, session management, and cleanup.
 */
import express, { type Express } from 'express';
import path from 'path';
import { TpaSession } from '../session';
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

/**
 * 🔧 Configuration options for TPA Server
 * 
 * @example
 * ```typescript
 * const config: TpaServerConfig = {
 *   packageName: 'org.example.myapp',
 *   apiKey: 'your_api_key',
 *   port: 7010,
 *   publicDir: './public'
 * };
 * ```
 */
export interface TpaServerConfig {
  /** 📦 Unique identifier for your TPA (e.g., 'org.company.appname') must match what you specified at https://console.augmentos.org */
  packageName: string;
  /** 🔑 API key for authentication with AugmentOS Cloud */
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

  /** 🔌 [DEPRECATED] No need to set this value */
  augmentOSWebsocketUrl?: string;
  /** ❤️ Enable health check endpoint at /health (default: true) */
  healthCheck?: boolean;
  /**
   * 🔐 Secret key used to sign session cookies
   * This must be a strong, unique secret
   */
  cookieSecret?: string;
}

/**
 * 🎯 TPA Server Implementation
 * 
 * Base class for creating TPA servers. Handles:
 * - 🔄 Session lifecycle management
 * - 📡 Webhook endpoints for AugmentOS Cloud
 * - 📂 Static file serving
 * - ❤️ Health checks
 * - 🧹 Cleanup on shutdown
 * 
 * @example
 * ```typescript
 * class MyAppServer extends TpaServer {
 *   protected async onSession(session: TpaSession, sessionId: string, userId: string) {
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
export class TpaServer {
  /** Express app instance */
  private app: Express;
  /** Map of active user sessions by sessionId */
  private activeSessions = new Map<string, TpaSession>();
  /** Array of cleanup handlers to run on shutdown */
  private cleanupHandlers: Array<() => void> = [];

  constructor(private config: TpaServerConfig) {
    // Set defaults and merge with provided config
    this.config = {
      port: 7010,
      webhookPath: '/webhook',
      augmentOSWebsocketUrl: "wss://staging.augmentos.org/tpa-ws",
      publicDir: false,
      healthCheck: true,
      ...config
    };

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
   * Override this method to handle new TPA sessions.
   * This is where you implement your app's core functionality.
   * 
   * @param session - TPA session instance for the user
   * @param sessionId - Unique identifier for this session
   * @param userId - User's identifier
   */
  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`New session: ${sessionId} for user ${userId}`);
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
    console.log(`Session ${sessionId} stopped for user ${userId}. Reason: ${reason}`);

    // Default implementation: close the session if it exists
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.disconnect();
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * 🛠️ Tool Call Handler
   * Override this method to handle tool calls from AugmentOS Cloud.
   * This is where you implement your app's tool functionality.
   * 
   * @param toolCall - The tool call request containing tool details and parameters
   * @returns Optional string response that will be sent back to AugmentOS Cloud
   */
  protected async onToolCall(toolCall: ToolCall): Promise<string | undefined> {
    console.log(`Tool call received: ${toolCall.toolId}`);
    console.log(`Parameters: ${JSON.stringify(toolCall.toolParameters)}`);
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
        console.log(`🎯 TPA server running at http://localhost:${this.config.port}`);
        if (this.config.publicDir) {
          console.log(`📂 Serving static files from ${this.config.publicDir}`);
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
    console.log('\n🛑 Shutting down...');
    this.cleanup();
    process.exit(0);
  }

  /**
 * 🔐 Generate a TPA token for a user
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
   * Creates the webhook endpoint that AugmentOS Cloud calls to start new sessions.
   */
  private setupWebhook(): void {
    if (!this.config.webhookPath) {
      console.error('❌ Webhook path not set');
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
          console.error('❌ Unknown webhook request type');
          res.status(400).json({
            status: 'error',
            message: 'Unknown webhook request type'
          } as WebhookResponse);
        }
      } catch (error) {
        console.error('❌ Error handling webhook:', error);
        res.status(500).json({
          status: 'error',
          message: 'Internal server error'
        } as WebhookResponse);
      }
    });
  }

  /**
   * 🛠️ Setup Tool Call Endpoint
   * Creates a /tool endpoint for handling tool calls from AugmentOS Cloud.
   */
  private setupToolCallEndpoint(): void {
    this.app.post('/tool', async (req, res) => {
      try {
        console.log(`\n\n🔧 Received tool call: ${JSON.stringify(req.body)}\n\n`);
        const toolCall = req.body as ToolCall;
        console.log(`\n\n🔧 Received tool call: ${toolCall.toolId}\n\n`);
        // Call the onToolCall handler and get the response
        const response = await this.onToolCall(toolCall);
        
        // Send back the response if one was provided
        if (response !== undefined) {
          res.json({ status: 'success', reply: response });
        } else {
          res.json({ status: 'success', reply: null });
        }
      } catch (error) {
        console.error('❌ Error handling tool call:', error);
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
    const { sessionId, userId } = request;
    console.log(`\n\n🗣️ Received session request for user ${userId}, session ${sessionId}\n\n`);
    
    // Create new TPA session
    const session = new TpaSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      augmentOSWebsocketUrl: request.augmentOSWebsocketUrl || this.config.augmentOSWebsocketUrl,
    });

    // Setup session event handlers
    const cleanupDisconnect = session.events.onDisconnected(() => {
      console.log(`👋 Session ${sessionId} disconnected`);
      this.activeSessions.delete(sessionId);
    });

    const cleanupError = session.events.onError((error) => {
      console.error(`❌ [Session ${sessionId}] Error:`, error);
    });

    // Start the session
    try {
      await session.connect(sessionId);
      this.activeSessions.set(sessionId, session);
      await this.onSession(session, sessionId, userId);
      res.status(200).json({ status: 'success' } as WebhookResponse);
    } catch (error) {
      console.error('❌ Failed to connect:', error);
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
    console.log(`\n\n🛑 Received stop request for user ${userId}, session ${sessionId}, reason: ${reason}\n\n`);

    try {
      await this.onStop(sessionId, userId, reason);
      res.status(200).json({ status: 'success' } as WebhookResponse);
    } catch (error) {
      console.error('❌ Error handling stop request:', error);
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
   * Creates a /settings endpoint that the AugmentOS Cloud can use to update settings.
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
        
        console.log(`📝 Received settings update for user ${userIdForSettings}`);
        
        // Find all active sessions for this user
        const userSessions: TpaSession[] = [];
        
        // Look through all active sessions
        this.activeSessions.forEach((session, sessionId) => {
          // Check if the session has this userId (not directly accessible)
          // We're relying on the webhook handler to have already verified this
          if (sessionId.includes(userIdForSettings)) {
            userSessions.push(session);
          }
        });
        
        if (userSessions.length === 0) {
          console.log(`⚠️ No active sessions found for user ${userIdForSettings}`);
        } else {
          console.log(`🔄 Updating settings for ${userSessions.length} active sessions`);
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
        console.error('❌ Error handling settings update:', error);
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
      console.log(`📂 Serving static files from ${publicPath}`);
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
      console.log(`👋 Closing session ${sessionId}`);
      session.disconnect();
    }
    this.activeSessions.clear();

    // Run cleanup handlers
    this.cleanupHandlers.forEach(handler => handler());
  }
}