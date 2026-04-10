import type { Context } from "hono";
import type { ToolCall } from "./types";
import type { AuthVariables, SessionWebhookRequest, StopWebhookRequest, WebhookResponse } from "./types";
import { AppServer, type AppServerConfig } from "./app/server";
import { AppSession } from "./app/session";
import { MentraSession } from "./session";
import { _SessionManager, type _ToolCallHandler } from "./internal/_SessionManager";

/**
 * Internal bridge session type used by the v2 override path.
 * When a developer subclasses MiniAppServer and overrides onSession(session, sessionId, userId),
 * the call goes through the old AppServer path which needs an AppSession instance.
 */
class V2BridgeSession extends AppSession {}

export type MiniAppServerConfig = AppServerConfig;

export type SessionHandler = (session: MentraSession) => void | Promise<void>;
export type StopHandler = (session: MentraSession | null, reason: string) => void | Promise<void>;
export type ToolCallHandler = _ToolCallHandler;

/**
 * v3 cloud/server host for Mentra mini apps.
 *
 * `MiniAppServer` is the cloud-only entry point. It handles HTTP endpoints
 * (webhooks, tools, settings, health, photo-upload) and creates MentraSession
 * instances for each connected user.
 *
 * Naming:
 * - `MiniAppServer` is cloud/server-specific (not needed for local apps).
 * - `MentraSession` is the per-user session abstraction (same everywhere).
 *
 * This class extends the v2 `AppServer` during the transition period.
 * When a v3-style callback is registered via `app.onSession((session) => {...})`,
 * webhook lifecycle flows through `_SessionManager` → `MentraSession` → v3 runtime.
 * When a v2-style subclass overrides `onSession(session, sessionId, userId)`,
 * it goes through the old `AppServer` path entirely.
 *
 * @example
 * ```ts
 * const app = new MiniAppServer({ packageName: "com.example.myapp", apiKey: "..." })
 *
 * app.onSession((session) => {
 *   session.transcription.on((data) => {
 *     session.display.showText(data.text)
 *   })
 * })
 *
 * await app.start()
 * ```
 */
export class MiniAppServer extends AppServer {
  private readonly _sessions: _SessionManager;

  constructor(config: MiniAppServerConfig) {
    super(config);
    this._sessions = new _SessionManager({
      packageName: config.packageName,
      apiKey: config.apiKey,
      logger: this.logger,
      serverUrl: config.cloudApiUrl,
      photoRequestBridge: {
        registerPhotoRequest: this.registerPhotoRequest.bind(this),
        completePhotoRequest: this.completePhotoRequest.bind(this),
      },
    });
  }

  // ─── Callback Registration (v3 pattern) ─────────────────────────────────

  public onSession(handler: SessionHandler): this;
  public override onSession(session: AppSession, sessionId: string, userId: string): Promise<void>;
  public override onSession(
    arg1: SessionHandler | AppSession,
    sessionId?: string,
    userId?: string,
  ): this | Promise<void> {
    if (typeof arg1 === "function") {
      // v3 path: developer passes a callback, we route through _SessionManager
      this._sessions.onSession((compatSession) => arg1(compatSession.session));
      return this;
    }

    // v2 path: developer subclassed and overrode onSession(session, sessionId, userId)
    const mentraSession = arg1 as V2BridgeSession;
    return super.onSession(mentraSession, sessionId!, userId!);
  }

  public onStop(handler: StopHandler): this;
  public override onStop(sessionId: string, userId: string, reason: string): Promise<void>;
  public override onStop(arg1: StopHandler | string, userId?: string, reason?: string): this | Promise<void> {
    if (typeof arg1 === "function") {
      this._sessions.onStop((session, stopReason) => arg1(session?.session ?? null, stopReason));
      return this;
    }

    return super.onStop(arg1, userId!, reason!);
  }

  public onToolCall(handler: ToolCallHandler): this;
  public override onToolCall(toolCall: ToolCall): Promise<string | undefined>;
  public override onToolCall(arg1: ToolCallHandler | ToolCall): this | Promise<string | undefined> {
    if (typeof arg1 === "function") {
      this._sessions.onToolCall(arg1);
      return this;
    }

    return super.onToolCall(arg1);
  }

  // ─── Webhook Handlers (override AppServer) ──────────────────────────────

  protected override async handleSessionWebhookRequest(
    request: SessionWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    try {
      const response = await this._sessions.handleSessionRequest(request);
      const record = this._sessions.getBySessionId(request.sessionId);
      if (record) {
        // Register in AppServer's active session tracking (for photo upload correlation, etc.)
        this.setActiveSession(request.sessionId, request.userId, record.compatSession as unknown as AppSession);

        record.compatSession.events.onDisconnected((info) => {
          if (!info?.permanent) return;

          if (this.getActiveSessionById(request.sessionId) === (record.compatSession as unknown as AppSession)) {
            this.removeActiveSession(request.sessionId, request.userId);
          }

          this.cleanupPhotoRequestsForSession(request.sessionId);
        });
      }

      return c.json(response as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Failed to connect MiniAppServer runtime session");
      return c.json(
        {
          status: "error",
          message: "Failed to connect",
        } as WebhookResponse,
        500,
      );
    }
  }

  protected override async handleStopWebhookRequest(
    request: StopWebhookRequest,
    c: Context<{ Variables: AuthVariables }>,
  ): Promise<Response> {
    try {
      const response = await this._sessions.handleStopRequest(request);
      this.removeActiveSession(request.sessionId, request.userId);
      return c.json(response as WebhookResponse);
    } catch (error) {
      this.logger.error(error, "Failed to stop MiniAppServer runtime session");
      return c.json(
        {
          status: "error",
          message: "Failed to process stop request",
        } as WebhookResponse,
        500,
      );
    }
  }
}
