/**
 * Photo Test API Routes
 *
 * POST /api/photo/take          — trigger a photo request, returns timing result
 * POST /api/photo/take-rapid    — fire N photo requests in quick succession
 * GET  /api/photo/results       — all results for a user
 * GET  /api/photo/stream        — SSE stream of photo test results
 * GET  /api/health              — health check
 *
 * Every photo request captures:
 * - Start time, completion time, duration
 * - Whether the result was success, specific error, or generic timeout
 * - Error code and message (if any)
 *
 * This lets us verify OS-947/OS-951: mini apps get real error messages
 * instead of waiting 30 seconds for a generic "Photo request timed out".
 */

import {Hono} from "hono"
import type {Context} from "hono"
import {getSession, getOrCreateSession, type PhotoTestResult} from "./PhotoTestApp"

const api = new Hono()

// ─── Health ──────────────────────────────────────────────────────────────────

api.get("/health", (c) => c.json({status: "ok", app: "photo-test", timestamp: new Date().toISOString()}))

// ─── Take Photo ──────────────────────────────────────────────────────────────

api.post("/photo/take", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const testSession = getSession(userId)
  if (!testSession?.appSession) {
    return c.json({error: "No active glasses session for this user"}, 404)
  }

  // Parse optional body for photo options
  let options: {saveToGallery?: boolean; size?: string; compress?: string} = {}
  try {
    const body = await c.req.json().catch(() => ({}))
    options = body || {}
  } catch {
    // no body is fine
  }

  const startedAt = Date.now()
  const pendingResult: PhotoTestResult = {
    requestId: `test_${startedAt}_${Math.random().toString(36).slice(2, 7)}`,
    status: "pending",
    startedAt,
    wasGenericTimeout: false,
  }

  // Add pending result so SSE clients see it immediately
  testSession.addResult(pendingResult)

  try {
    const photo = await testSession.appSession.camera.requestPhoto({
      saveToGallery: options.saveToGallery ?? false,
      size: (options.size as any) || "medium",
      compress: (options.compress as any) || "none",
    })

    const completedAt = Date.now()
    const durationMs = completedAt - startedAt

    const successResult: Partial<PhotoTestResult> = {
      status: "success",
      completedAt,
      durationMs,
      photoSize: photo.size,
      photoMimeType: photo.mimeType,
      wasGenericTimeout: false,
    }

    const updated = testSession.updateResult(pendingResult.requestId, successResult)
    return c.json({result: updated})
  } catch (error: unknown) {
    const completedAt = Date.now()
    const durationMs = completedAt - startedAt
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Detect if this was a generic timeout vs a specific error
    // Generic timeout: "Photo request timed out" (the bad case — OS-947)
    // Specific error: anything else, e.g. "CAMERA_BUSY: Streamer is running"
    const isGenericTimeout = errorMessage.includes("timed out") || errorMessage.includes("Timeout")

    // Try to extract error code from "CODE: message" format
    let errorCode: string | undefined
    const codeMatch = errorMessage.match(/^([A-Z_]+):\s/)
    if (codeMatch) {
      errorCode = codeMatch[1]
    }

    const errorResult: Partial<PhotoTestResult> = {
      status: isGenericTimeout ? "timeout" : "error",
      completedAt,
      durationMs,
      errorMessage,
      errorCode,
      wasGenericTimeout: isGenericTimeout,
    }

    const updated = testSession.updateResult(pendingResult.requestId, errorResult)
    return c.json({result: updated})
  }
})

// ─── Rapid Fire (multiple photo requests) ────────────────────────────────────

api.post("/photo/take-rapid", async (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const testSession = getSession(userId)
  if (!testSession?.appSession) {
    return c.json({error: "No active glasses session for this user"}, 404)
  }

  let count = 3
  try {
    const body = await c.req.json().catch(() => ({}))
    if (body?.count && typeof body.count === "number") {
      count = Math.min(Math.max(body.count, 1), 10) // 1–10
    }
  } catch {
    // default count
  }

  // Fire all photo requests concurrently
  const promises = Array.from({length: count}, async (_, i) => {
    const startedAt = Date.now()
    const pendingResult: PhotoTestResult = {
      requestId: `rapid_${startedAt}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      status: "pending",
      startedAt,
      wasGenericTimeout: false,
    }
    testSession.addResult(pendingResult)

    try {
      const photo = await testSession.appSession!.camera.requestPhoto({
        size: "small",
        compress: "heavy",
      })

      const completedAt = Date.now()
      testSession.updateResult(pendingResult.requestId, {
        status: "success",
        completedAt,
        durationMs: completedAt - startedAt,
        photoSize: photo.size,
        photoMimeType: photo.mimeType,
        wasGenericTimeout: false,
      })
      return {requestId: pendingResult.requestId, status: "success"}
    } catch (error: unknown) {
      const completedAt = Date.now()
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isGenericTimeout = errorMessage.includes("timed out") || errorMessage.includes("Timeout")

      testSession.updateResult(pendingResult.requestId, {
        status: isGenericTimeout ? "timeout" : "error",
        completedAt,
        durationMs: completedAt - startedAt,
        errorMessage,
        wasGenericTimeout: isGenericTimeout,
      })
      return {requestId: pendingResult.requestId, status: "error", errorMessage}
    }
  })

  const results = await Promise.allSettled(promises)
  return c.json({
    count,
    results: results.map((r) => (r.status === "fulfilled" ? r.value : {status: "rejected"})),
  })
})

// ─── Get All Results ─────────────────────────────────────────────────────────

api.get("/photo/results", (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const testSession = getSession(userId)
  if (!testSession) return c.json({results: []})

  return c.json({results: testSession.results})
})

// ─── Clear Results ───────────────────────────────────────────────────────────

api.delete("/photo/results", (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const testSession = getSession(userId)
  if (testSession) {
    testSession.results = []
  }
  return c.json({cleared: true})
})

// ─── SSE Stream ──────────────────────────────────────────────────────────────

api.get("/photo/stream", (c) => {
  const userId = c.req.query("userId")
  if (!userId) {
    return c.json({error: "userId query param is required"}, 400)
  }

  // Use getOrCreateSession so the SSE stream is always available —
  // the glasses session may connect after the webview opens.
  const testSession = getOrCreateSession(userId)

  // SSE via ReadableStream
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      const sseWriter = {
        write: (data: string) => {
          try {
            controller.enqueue(encoder.encode(data))
          } catch {
            // stream closed
          }
        },
        close: () => {
          try {
            controller.close()
          } catch {
            // already closed
          }
        },
      }

      testSession.sseClients.add(sseWriter)

      // Send all existing results as initial payload
      for (const result of [...testSession.results].reverse()) {
        sseWriter.write(`data: ${JSON.stringify(result)}\n\n`)
      }

      // Keepalive ping
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"))
        } catch {
          clearInterval(keepalive)
        }
      }, 15_000)

      // Cleanup on cancel
      c.req.raw.signal.addEventListener("abort", () => {
        testSession.sseClients.delete(sseWriter)
        clearInterval(keepalive)
        try {
          controller.close()
        } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
})

// ─── Session Status ──────────────────────────────────────────────────────────

api.get("/session/status", (c) => {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId query param is required"}, 400)

  const testSession = getSession(userId)
  return c.json({
    connected: !!testSession?.appSession,
    userId,
    resultCount: testSession?.results.length ?? 0,
    sseClients: testSession?.sseClients.size ?? 0,
  })
})

export {api}
