/**
 * Giga-agent delegation — server-side control-plane client.
 *
 * The user's persistent "giga-agent" lives behind the `testaiassistant` control
 * plane (a separate service). Delegation is the fast agent's escalation path for
 * multi-step / personal-account / long-running work.
 *
 * This client lives in the BACKEND because the shared control-plane key is a
 * server secret — it must never ship inside the miniapp bundle. The miniapp's
 * background reaches it only through `/api/agent` (the agent tool-loop) and
 * `/api/agent/task/:id` (the follow-up poll), both auth-gated.
 *
 * The control plane keys everything on `userId` = the caller's `mentraUserId`
 * (a PII-free ULID, also the permanent key of the agent's memory volume). Its
 * userId validator must accept that charset (`[A-Za-z0-9_-]{1,64}`).
 */

import type {AgentAction} from "./types"

const BASE_URL = (process.env.AGENTS_BASE_URL ?? "").replace(/\/+$/, "")
const API_KEY = process.env.MENTRA_AGENT_API_KEY ?? ""

/** Grace window (ms) a delegation blocks before returning an ack + a pending taskId. */
export const DELEGATE_GRACE_MS = parseInt(process.env.AGENT_DELEGATE_GRACE_MS ?? "2000", 10)

const REQUEST_TIMEOUT_MS = 15_000

/** True when delegation is fully configured; otherwise `ask_agent` is not offered. */
export function isDelegationEnabled(): boolean {
  return Boolean(BASE_URL && API_KEY)
}

export type {AgentAction}

/** Flat device-context the agent gets (so it never re-asks what the device knows). */
export type AgentContextPayload = Record<string, string>

export type DelegateResult =
  | {status: "done"; reply: string; actions: AgentAction[]}
  | {status: "working"; taskId: string; ack: string}
  | {status: "failed"; error: string}

export interface DelegationTaskResult {
  status: "working" | "done" | "failed"
  reply?: string
  actions?: AgentAction[]
  error?: string
}

function headers(): Record<string, string> {
  return {"Content-Type": "application/json", "x-api-key": API_KEY}
}

function userPath(userId: string): string {
  return `${BASE_URL}/api/users/${encodeURIComponent(userId)}`
}

/**
 * Delegate a task. Resolves `done` if the agent answered within the grace
 * window, otherwise `working` (carrying a taskId the caller polls via getTask).
 * The control plane is the slow part — it loops a Hermes agent — so a long task
 * returns `working` and finishes in the background.
 */
export async function delegateMessage(
  userId: string,
  task: string,
  context?: AgentContextPayload,
): Promise<DelegateResult> {
  const body: Record<string, unknown> = {text: task, wait_ms: DELEGATE_GRACE_MS}
  if (context && Object.keys(context).length) body.context = context

  let res: Response
  try {
    res = await fetch(`${userPath(userId)}/message`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELEGATE_GRACE_MS + REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return {status: "failed", error: err instanceof Error ? err.message : String(err)}
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (res.status === 202 && data.status === "working") {
    return {
      status: "working",
      taskId: String(data.taskId),
      ack: typeof data.ack === "string" ? data.ack : "",
    }
  }
  if (res.ok && data.status === "done") {
    return {
      status: "done",
      reply: typeof data.reply === "string" ? data.reply : "",
      actions: Array.isArray(data.actions) ? (data.actions as AgentAction[]) : [],
    }
  }
  return {
    status: "failed",
    error: typeof data.error === "string" ? data.error : `delegation failed (${res.status})`,
  }
}

/** Poll a pending task's state. Returns null on a transport error (caller retries). */
export async function getDelegationTask(
  userId: string,
  taskId: string,
): Promise<DelegationTaskResult | null> {
  try {
    const res = await fetch(`${userPath(userId)}/tasks/${encodeURIComponent(taskId)}`, {
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const status = data.status === "done" || data.status === "failed" ? data.status : "working"
    return {
      status,
      reply: typeof data.reply === "string" ? data.reply : undefined,
      actions: Array.isArray(data.actions) ? (data.actions as AgentAction[]) : undefined,
      error: typeof data.error === "string" ? data.error : undefined,
    }
  } catch {
    return null
  }
}

/** Predictive wake — warm the user's container (fire-and-forget). */
export async function wakeDelegation(userId: string): Promise<void> {
  if (!isDelegationEnabled()) return
  try {
    await fetch(`${userPath(userId)}/wake`, {
      method: "POST",
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    /* best-effort */
  }
}
