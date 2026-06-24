/**
 * AgentBridge — REST client for the giga-agent control plane.
 *
 * Wraps the three endpoints the miniapp needs from `testaiassistant`
 * (`control-plane/server.js`):
 *
 *   POST /api/users/:userId/message   delegate a task (with the 2s grace
 *                                      contract: 200 done | 202 working)
 *   POST /api/users/:userId/wake      predictively warm the user's container
 *   GET  /api/users/:userId/tasks/:id poll a pending task (webhook backstop)
 *
 * All calls send the shared `x-api-key`. This is server-to-server only —
 * the key lives in the miniapp's env (Doppler/porter) and never reaches a
 * device. `userId` is the SDK's `mentraUserId` (a PII-free ULID), which
 * doubles as the permanent key of the agent's memory volume.
 *
 * The control plane's userId regex must accept the ULID charset
 * (`[A-Za-z0-9_-]{1,64}`); see the integration plan.
 */

import { AGENT_DELEGATION } from "../constants/config";

/** Structured action extracted by the control plane (a URL the user opens). */
export interface AgentAction {
  type: "open_url";
  kind: "oauth_connect" | "link";
  url: string;
}

/** Flat device context forwarded to the agent (location/time/units/device). */
export type AgentContextPayload = Record<string, string>;

export interface AgentMessageInput {
  userId: string;
  text: string;
  /** data: URL or raw base64 JPEG (POV photo). Optional. */
  image?: string;
  context?: AgentContextPayload;
  /** Block up to this long for a fast result before bailing to async. */
  waitMs?: number;
  /** Where the control plane POSTs the result when the task runs long. */
  webhookUrl?: string;
}

/** Discriminated result of a delegation. */
export type AgentMessageResult =
  | { status: "done"; reply: string; actions: AgentAction[]; ms?: number }
  | { status: "working"; taskId: string; ack: string }
  | { status: "failed"; error: string; taskId?: string };

export interface AgentTaskResult {
  taskId: string;
  userId: string;
  status: "working" | "done" | "failed";
  reply?: string;
  actions?: AgentAction[];
  ack?: string;
  error?: string;
  ms?: number;
}

const REQUEST_TIMEOUT_MS = 15_000;

export class AgentBridge {
  private get baseUrl(): string {
    return AGENT_DELEGATION.baseUrl.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": AGENT_DELEGATION.apiKey,
    };
  }

  private userPath(userId: string): string {
    return `${this.baseUrl}/api/users/${encodeURIComponent(userId)}`;
  }

  /**
   * Delegate a task. Resolves to `done` if the agent answered within
   * `waitMs`, otherwise `working` (carrying a taskId + speakable ack) —
   * the real result then arrives via the webhook and/or `getTask`.
   */
  async message(input: AgentMessageInput): Promise<AgentMessageResult> {
    const body: Record<string, unknown> = { text: input.text };
    if (input.image) body.image = input.image;
    if (input.context && Object.keys(input.context).length) body.context = input.context;
    if (input.waitMs != null) body.wait_ms = input.waitMs;
    if (input.webhookUrl) body.webhook_url = input.webhookUrl;

    const res = await fetch(`${this.userPath(input.userId)}/message`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      // The control plane holds the request open for up to waitMs; give it
      // headroom beyond the grace window before we treat it as a failure.
      signal: AbortSignal.timeout((input.waitMs ?? 0) + REQUEST_TIMEOUT_MS),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.status === 202 && data.status === "working") {
      return {
        status: "working",
        taskId: String(data.taskId),
        ack: typeof data.ack === "string" ? data.ack : "",
      };
    }
    if (res.ok && data.status === "done") {
      return {
        status: "done",
        reply: typeof data.reply === "string" ? data.reply : "",
        actions: Array.isArray(data.actions) ? (data.actions as AgentAction[]) : [],
        ms: typeof data.ms === "number" ? data.ms : undefined,
      };
    }
    return {
      status: "failed",
      error: typeof data.error === "string" ? data.error : `agent message failed (${res.status})`,
      taskId: typeof data.taskId === "string" ? data.taskId : undefined,
    };
  }

  /**
   * Predictive wake: warm the user's container at wake-word time so it is
   * ready by the time the fast agent decides whether to delegate.
   * Fire-and-forget — never throws into the caller.
   */
  async wake(userId: string): Promise<void> {
    try {
      await fetch(`${this.userPath(userId)}/wake`, {
        method: "POST",
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`🤝 [AgentBridge] wake failed for ${userId}:`, err instanceof Error ? err.message : err);
    }
  }

  /** Poll a task's current state (webhook backstop). */
  async getTask(userId: string, taskId: string): Promise<AgentTaskResult | null> {
    try {
      const res = await fetch(`${this.userPath(userId)}/tasks/${encodeURIComponent(taskId)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as AgentTaskResult;
    } catch {
      return null;
    }
  }
}

/** Singleton — import this everywhere. */
export const agentBridge = new AgentBridge();
