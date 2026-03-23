/**
 * PhotoTestApp — MentraOS AppServer for testing photo request flows.
 *
 * Specifically tests:
 * - Photo capture success path (glasses → /photo-upload → resolve)
 * - Photo error path (phone → cloud REST → cloud WS → reject) — OS-947/OS-951
 * - Timeout behavior (should only happen if both paths fail)
 * - Timing: how fast errors are reported vs 30s timeout
 *
 * Each photo request is logged with timing metadata so the webview
 * can display whether we got a real error or a generic timeout.
 */

import { AppServer, AppSession } from "@mentra/sdk"

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PhotoTestResult {
  requestId: string
  status: "success" | "error" | "timeout" | "pending"
  startedAt: number
  completedAt?: number
  durationMs?: number
  errorMessage?: string
  errorCode?: string
  photoSize?: number
  photoMimeType?: string
  /** Whether the error was a specific message (good) or generic timeout (bad — OS-947) */
  wasGenericTimeout: boolean
}

interface SSEWriter {
  write: (data: string) => void
  close: () => void
}

/** Per-user state for photo testing */
class PhotoTestSession {
  appSession: AppSession | null = null
  results: PhotoTestResult[] = []
  sseClients: Set<SSEWriter> = new Set()

  constructor(public readonly userId: string) {}

  addResult(result: PhotoTestResult): void {
    this.results.unshift(result) // newest first
    if (this.results.length > 50) this.results.pop() // cap at 50
    this.broadcast(result)
  }

  updateResult(requestId: string, update: Partial<PhotoTestResult>): PhotoTestResult | undefined {
    const result = this.results.find((r) => r.requestId === requestId)
    if (result) {
      Object.assign(result, update)
      this.broadcast(result)
    }
    return result
  }

  broadcast(result: PhotoTestResult): void {
    const payload = `data: ${JSON.stringify(result)}\n\n`
    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  cleanup(): void {
    for (const client of this.sseClients) {
      try {
        client.close()
      } catch {}
    }
    this.sseClients.clear()
    this.results = []
    this.appSession = null
  }
}

// ─── Session Store ───────────────────────────────────────────────────────────

const SESSIONS_KEY = Symbol.for("mentra.photo-test.sessions")
;(globalThis as any)[SESSIONS_KEY] ??= new Map<string, PhotoTestSession>()

function getSessions(): Map<string, PhotoTestSession> {
  return (globalThis as any)[SESSIONS_KEY]
}

export function getSession(userId: string): PhotoTestSession | undefined {
  return getSessions().get(userId)
}

export function getOrCreateSession(userId: string): PhotoTestSession {
  let session = getSessions().get(userId)
  if (!session) {
    session = new PhotoTestSession(userId)
    getSessions().set(userId, session)
  }
  return session
}

export function removeSession(userId: string): void {
  const session = getSessions().get(userId)
  if (session) {
    session.cleanup()
    getSessions().delete(userId)
  }
}

// ─── App Server ──────────────────────────────────────────────────────────────

export interface PhotoTestAppConfig {
  packageName: string
  apiKey: string
  port: number
  cookieSecret?: string
}

export class PhotoTestApp extends AppServer {
  constructor(config: PhotoTestAppConfig) {
    super({
      packageName: config.packageName,
      apiKey: config.apiKey,
      port: config.port,
      cookieSecret: config.cookieSecret,
    })
  }

  /** Called when a user launches the app on their glasses */
  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    const testSession = getOrCreateSession(userId)
    testSession.appSession = session

    // Show connection confirmation on glasses
    session.layouts.showTextWall("📸 Photo Test\nConnected — use webview to test")
  }

  /** Called when a user closes the app or disconnects */
  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    removeSession(userId)
  }
}
