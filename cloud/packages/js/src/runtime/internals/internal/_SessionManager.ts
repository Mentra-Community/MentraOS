/**
 * _SessionManager
 *
 * Consolidated server-level session orchestrator. Merges the responsibilities
 * of the previous four separate classes into one:
 *
 *   _MentraSessionServerFactory  → createSession()
 *   _MiniAppSessionRegistry      → session tracking (bySessionId, byUserId maps)
 *   _MiniAppServerCallbackBridge → callback storage (onSession, onStop, onToolCall)
 *   _MiniAppServerRuntime        → webhook handling (handleSessionRequest, handleStopRequest)
 *
 * This is an internal class — never exported to developers.
 * MiniAppServer is the only consumer.
 *
 * See decisions.md D-007 for rationale on the consolidation.
 *
 * @internal
 */

import type { Logger } from "pino";
import type { WebhookResponse, SessionWebhookRequest, StopWebhookRequest, ToolCall } from "../types";
import type { MentraSessionConfig } from "../session";
import { MentraSession } from "../session";
import { WebSocketTransport } from "../transport/WebSocketTransport";
import { _V2SessionShim } from "../session/internal/_V2SessionShim";
import type { _V2PhotoRequestBridge } from "../session/internal/_V2CameraShim";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface _SessionManagerConfig {
  packageName: string;
  apiKey: string;
  logger: Logger;
  serverUrl?: string;
  logLevel?: MentraSessionConfig["logLevel"];
  verbose?: MentraSessionConfig["verbose"];
  photoRequestBridge?: _V2PhotoRequestBridge;
}

export type _SessionHandler = (session: _V2SessionShim) => void | Promise<void>;
export type _StopHandler = (session: _V2SessionShim | null, reason: string) => void | Promise<void>;
export type _ToolCallHandler = (toolCall: ToolCall) => string | undefined | Promise<string | undefined>;

interface SessionRecord {
  session: MentraSession;
  compatSession: _V2SessionShim;
  userId: string;
  sessionId: string;
}

// ─── _SessionManager ────────────────────────────────────────────────────────

export class _SessionManager {
  private readonly config: _SessionManagerConfig;
  private readonly logger: Logger;

  // ─── Registry (was _MiniAppSessionRegistry) ───────────────────────────
  private readonly bySessionId = new Map<string, SessionRecord>();
  private readonly byUserId = new Map<string, SessionRecord>();

  // ─── Callbacks (was _MiniAppServerCallbackBridge) ─────────────────────
  private sessionHandler?: _SessionHandler;
  private stopHandler?: _StopHandler;
  private toolCallHandler?: _ToolCallHandler;
  private readonly callbackSessionCache = new Map<string, _V2SessionShim>();

  // ─── Lifecycle ────────────────────────────────────────────────────────
  private readonly stopSuppression = new Set<string>();

  constructor(config: _SessionManagerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  // ─── Callback Registration ────────────────────────────────────────────

  onSession(handler: _SessionHandler): void {
    this.sessionHandler = handler;
  }

  onStop(handler: _StopHandler): void {
    this.stopHandler = handler;
  }

  onToolCall(handler: _ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  // ─── Registry Queries ─────────────────────────────────────────────────

  getBySessionId(sessionId: string): SessionRecord | null {
    return this.bySessionId.get(sessionId) ?? null;
  }

  getByUserId(userId: string): SessionRecord | null {
    return this.byUserId.get(userId) ?? null;
  }

  get size(): number {
    return this.bySessionId.size;
  }

  // ─── Webhook Handlers ─────────────────────────────────────────────────

  async handleSessionRequest(request: SessionWebhookRequest): Promise<WebhookResponse> {
    // Tear down any existing session for this sessionId
    const existing = this.bySessionId.get(request.sessionId);
    if (existing) {
      this.stopSuppression.add(request.sessionId);
      try {
        await existing.compatSession.releaseOwnership("switching_clouds");
      } catch (error) {
        this.logger.warn({ error, sessionId: request.sessionId }, "Failed to release ownership on existing session");
      }

      await existing.session.disconnect();
      this.deleteIfSameSession(request.sessionId, existing.session);
      this.stopSuppression.delete(request.sessionId);
    }

    // Create new session (was _MentraSessionServerFactory.create)
    const created = this.createSession(request);

    // Register in maps
    this.registrySet({
      session: created.session,
      compatSession: created.compatSession,
      userId: request.userId,
      sessionId: request.sessionId,
    });

    // Wire up permanent-disconnect → stop handler
    created.compatSession.events.onDisconnected(async (info) => {
      if (!info?.permanent) return;

      const removed = this.deleteIfSameSession(request.sessionId, created.session);
      if (!removed) return;
      if (this.stopSuppression.has(request.sessionId)) return;

      try {
        await this.invokeStopHandler(request.sessionId, info.reason || "Session disconnected");
      } catch (error) {
        this.logger.error(error, "Stop handler failed after permanent disconnect");
      }
    });

    // Wire up error logging
    created.compatSession.events.onError((error) => {
      this.logger.error(error, "Session runtime error");
    });

    // Connect the WebSocket
    try {
      await created.session.connect();
    } catch (error) {
      this.deleteIfSameSession(request.sessionId, created.session);
      throw error;
    }

    // Invoke the developer's onSession callback
    await this.invokeSessionHandler(created.compatSession, request.sessionId);

    return { status: "success" };
  }

  async handleStopRequest(request: StopWebhookRequest): Promise<WebhookResponse> {
    this.stopSuppression.add(request.sessionId);
    const existing = this.registryDeleteBySessionId(request.sessionId);
    if (existing) {
      await existing.session.disconnect();
    }

    try {
      await this.invokeStopHandler(request.sessionId, request.reason);
    } finally {
      this.stopSuppression.delete(request.sessionId);
    }
    return { status: "success" };
  }

  async handleToolCall(toolCall: ToolCall): Promise<{ status: "success"; reply: string | null }> {
    const activeSession = this.byUserId.get(toolCall.userId)?.compatSession ?? null;
    const response = await this.invokeToolCallHandler({
      ...toolCall,
      activeSession: activeSession as any,
    });

    return {
      status: "success",
      reply: response ?? null,
    };
  }

  async shutdown(): Promise<void> {
    for (const record of Array.from(this.bySessionId.values())) {
      this.stopSuppression.add(record.sessionId);
      await record.session.disconnect();
    }
    this.bySessionId.clear();
    this.byUserId.clear();
    this.callbackSessionCache.clear();
    this.stopSuppression.clear();
  }

  // ─── Session Factory (was _MentraSessionServerFactory) ────────────────

  private createSession(request: SessionWebhookRequest): {
    session: MentraSession;
    compatSession: _V2SessionShim;
  } {
    const websocketUrl = request.websocketUrl || request.mentraOSWebsocketUrl || request.augmentOSWebsocketUrl;
    if (!websocketUrl) {
      throw new Error("Session webhook is missing websocketUrl/mentraOSWebsocketUrl/augmentOSWebsocketUrl");
    }

    const transport = new WebSocketTransport({
      url: websocketUrl,
      headers: {
        "x-user-id": request.userId,
        "x-session-id": request.sessionId,
        "x-package-name": this.config.packageName,
        "x-api-key": this.config.apiKey,
      },
    });

    const session = new MentraSession({
      packageName: this.config.packageName,
      apiKey: this.config.apiKey,
      sessionId: request.sessionId,
      userId: request.userId,
      serverUrl: this.config.serverUrl,
      transport,
      logLevel: this.config.logLevel,
      verbose: this.config.verbose,
    });

    const compatSession = new _V2SessionShim(session, {
      photoRequestBridge: this.config.photoRequestBridge,
    });

    return { session, compatSession };
  }

  // ─── Registry Operations (was _MiniAppSessionRegistry) ────────────────

  private registrySet(record: SessionRecord): void {
    this.bySessionId.set(record.sessionId, record);
    this.byUserId.set(record.userId, record);
  }

  private registryDeleteBySessionId(sessionId: string): SessionRecord | null {
    const record = this.bySessionId.get(sessionId) ?? null;
    if (!record) return null;

    this.bySessionId.delete(sessionId);
    if (this.byUserId.get(record.userId)?.sessionId === sessionId) {
      this.byUserId.delete(record.userId);
    }

    return record;
  }

  private deleteIfSameSession(sessionId: string, session: MentraSession): SessionRecord | null {
    const record = this.bySessionId.get(sessionId) ?? null;
    if (!record || record.session !== session) return null;
    return this.registryDeleteBySessionId(sessionId);
  }

  // ─── Callback Invocation (was _MiniAppServerCallbackBridge) ───────────

  private async invokeSessionHandler(session: _V2SessionShim, sessionId: string): Promise<void> {
    this.callbackSessionCache.set(sessionId, session);

    if (this.sessionHandler) {
      await this.sessionHandler(session);
    }
  }

  private async invokeStopHandler(sessionId: string, reason: string): Promise<void> {
    const session = this.callbackSessionCache.get(sessionId) ?? null;
    this.callbackSessionCache.delete(sessionId);

    if (this.stopHandler) {
      await this.stopHandler(session, reason);
    }
  }

  private async invokeToolCallHandler(toolCall: ToolCall): Promise<string | undefined> {
    if (this.toolCallHandler) {
      return this.toolCallHandler(toolCall);
    }
    return undefined;
  }
}
