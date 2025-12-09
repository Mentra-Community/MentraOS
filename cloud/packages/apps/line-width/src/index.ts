/**
 * Line Width Debug Tool - Main Entry Point
 *
 * A debug application to discover and validate optimal text wrapping logic
 * for G1 glasses display by testing actual pixel widths against glasses firmware behavior.
 *
 * Features:
 * - Manual text testing (presets, custom text)
 * - Random text stress testing
 * - Live transcription with diarization support
 *
 * Port 3334 (Bun)     - Serves React webview + API routes
 * Port 3333 (Express) - Handles MentraOS AppServer + proxies to Bun
 */

import {serve} from "bun"

import {routes} from "./api/routes"
import {LiveCaptionsApp} from "./app"
import {UserSession} from "./app/session/UserSession"
import indexDev from "./webview/index.html"
import indexProd from "./webview/index.prod.html"

// Configuration
const PORT = parseInt(process.env.PORT || "3333", 10)
const BUN_PORT = PORT + 1 // 3334
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mentra.linewidth"
const API_KEY = process.env.MENTRAOS_API_KEY || ""

if (!API_KEY) {
  console.error("❌ MENTRAOS_API_KEY environment variable is not set")
  process.exit(1)
}

if (!PACKAGE_NAME) {
  console.error("❌ PACKAGE_NAME environment variable is not set")
  process.exit(1)
}

console.log("🚀 Starting Line Width Debug Tool...\n")

// ============================================
// Step 1: Start Bun Server (Port 3334)
// ============================================

console.log(`📦 Starting Bun server on port ${BUN_PORT}...`)
const isDevelopment = process.env.NODE_ENV === "development"

const bunServer = serve({
  development: isDevelopment && {
    hmr: true,
  },
  port: BUN_PORT,
  routes: {
    // Custom API routes
    ...routes,

    // Serve webview
    "/*": isDevelopment ? indexDev : indexProd,
  },
})

console.log(`✅ Bun server running at ${bunServer.url}`)
console.log(`   - Webview: ${bunServer.url}`)
console.log(`   - API: ${bunServer.url}/api/health\n`)

// ============================================
// Step 2: Start Express/AppServer (Port 3333)
// ============================================

console.log(`📱 Starting MentraOS AppServer on port ${PORT}...`)

const lineWidthApp = new LiveCaptionsApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
})

// Start AppServer first (registers all MentraOS routes)
await lineWidthApp.start()

// Get Express app instance AFTER starting (routes are registered)
const expressApp = lineWidthApp.getExpressApp()

// ============================================
// Connection Status Route (Express - has access to lineWidthApp)
// ============================================
expressApp.get("/api/connection-status", (_req, res) => {
  const sessions = lineWidthApp.getActiveSessions()
  const sessionCount = sessions.size

  res.json({
    connected: sessionCount > 0,
    sessionCount,
    sessions: Array.from(sessions.keys()),
  })
})

// ============================================
// Send Text to Glasses Route (Express - has access to lineWidthApp)
// ============================================
expressApp.post("/api/send-text", async (req, res) => {
  const {text, charType, pixels} = req.body

  if (!text) {
    return res.status(400).json({error: "text is required"})
  }

  const sessions = lineWidthApp.getActiveSessions()

  if (sessions.size === 0) {
    return res.status(404).json({error: "No active glasses sessions"})
  }

  // Send to all active sessions
  const results: Array<{userId: string; success: boolean; error?: string}> = []

  for (const [userId, _session] of sessions) {
    try {
      const success = await lineWidthApp.sendTestText(userId, text)
      results.push({userId, success})
    } catch (err) {
      results.push({userId, success: false, error: String(err)})
    }
  }

  const anySuccess = results.some((r) => r.success)

  res.json({
    success: anySuccess,
    sent: {
      text,
      charType: charType || "unknown",
      pixels: pixels || 0,
      charCount: text.length,
      timestamp: Date.now(),
    },
    results,
  })
})

// ============================================
// Transcripts API Route (Express - shares UserSession state)
// ============================================
expressApp.get("/api/transcripts", (req, res) => {
  const authReq = req as any
  const userId = authReq.authUserId

  console.log(`[API] /api/transcripts request - userId: ${userId}`)

  if (!userId) {
    return res.status(401).json({error: "Not authenticated"})
  }

  const userSession = UserSession.getUserSession(userId)
  console.log(`[API] UserSession lookup for ${userId}: ${userSession ? "FOUND" : "NOT FOUND"}`)

  if (!userSession) {
    return res.status(404).json({error: "No active session"})
  }

  const transcripts = userSession.transcripts.getAll()
  res.json({transcripts})
})

// ============================================
// Toggle Character Breaking Mode (Express - shares UserSession state)
// ============================================
expressApp.post("/api/settings/character-breaking", (req, res) => {
  const authReq = req as any
  const userId = authReq.authUserId

  if (!userId) {
    return res.status(401).json({error: "Not authenticated"})
  }

  const userSession = UserSession.getUserSession(userId)
  if (!userSession) {
    return res.status(404).json({error: "No active session"})
  }

  const {enabled} = req.body
  if (typeof enabled !== "boolean") {
    return res.status(400).json({error: "enabled must be a boolean"})
  }

  userSession.display.setCharacterBreaking(enabled)

  res.json({
    success: true,
    characterBreaking: enabled,
    message: enabled
      ? "Character breaking enabled - 100% line utilization with hyphens"
      : "Character breaking disabled - word boundary breaking (hyphenates only long words)",
  })
})

expressApp.get("/api/settings/character-breaking", (req, res) => {
  const authReq = req as any
  const userId = authReq.authUserId

  if (!userId) {
    return res.status(401).json({error: "Not authenticated"})
  }

  const userSession = UserSession.getUserSession(userId)
  if (!userSession) {
    return res.status(404).json({error: "No active session"})
  }

  res.json({
    characterBreaking: userSession.display.isCharacterBreakingEnabled(),
  })
})

// ============================================
// Debug Sessions Route (Express - shares UserSession state)
// ============================================
expressApp.get("/api/debug/sessions", (req, res) => {
  const authReq = req as any
  const userId = authReq.authUserId
  const allSessions = Array.from(UserSession.userSessions.keys())
  const hasSessionForUser = userId ? UserSession.userSessions.has(userId) : false

  res.json({
    auth: {
      userId,
      hasSession: !!authReq.activeSession,
      isAuthenticated: !!userId,
    },
    activeSessions: allSessions,
    sessionCount: allSessions.length,
    hasSessionForCurrentUser: hasSessionForUser,
    message:
      allSessions.length === 0
        ? "No glasses connected. Connect glasses to this app to enable Live mode."
        : `${allSessions.length} active session(s)`,
  })
})

// ============================================
// SSE Stream Route for Live Transcription (bypasses proxy)
// ============================================
const SSE_HEARTBEAT_INTERVAL_MS = 15000 // Send heartbeat every 15 seconds

expressApp.get("/api/transcripts/stream", (req, res) => {
  console.log(`[SSE] *** HIT /api/transcripts/stream route ***`)

  const authReq = req as any
  const userId = authReq.authUserId

  console.log(`[SSE] /api/transcripts/stream request - userId: ${userId}`)
  console.log(
    `[SSE] Request headers:`,
    JSON.stringify({
      cookie: req.headers.cookie ? "present" : "missing",
      authorization: req.headers.authorization ? "present" : "missing",
    }),
  )

  if (!userId) {
    console.log("[SSE] Unauthorized - no userId")
    return res.status(401).send("Unauthorized")
  }

  const userSession = UserSession.getUserSession(userId)
  console.log(`[SSE] UserSession lookup for ${userId}: ${userSession ? "FOUND" : "NOT FOUND"}`)
  console.log(`[SSE] All UserSessions: ${Array.from(UserSession.userSessions.keys()).join(", ")}`)

  if (!userSession) {
    console.log("[SSE] No active session for user")
    return res.status(404).send("No active session")
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")

  // Send initial connection message
  res.write(`data: ${JSON.stringify({type: "connected"})}\n\n`)

  // Track if connection is still alive
  let isAlive = true

  // Create SSE client
  const clientId = `${userId}-${Date.now()}`
  const client = {
    send: (data: any) => {
      if (!isAlive) {
        console.log(`[SSE] Client ${clientId} skipping send - not alive`)
        return
      }
      try {
        const written = res.write(`data: ${JSON.stringify(data)}\n\n`)
        if (!written) {
          console.log(`[SSE] Client ${clientId} write returned false - buffer full or closed`)
        }
      } catch (err) {
        console.log(`[SSE] Client ${clientId} send error:`, err)
        // Client disconnected
        isAlive = false
        userSession.transcripts.removeSSEClient(client)
      }
    },
  }
  console.log(`[SSE] Created client ${clientId}`)

  // Register client
  console.log(`[SSE] Registering SSE client for user ${userId}`)
  userSession.transcripts.addSSEClient(client)
  console.log(`[SSE] SSE client registered. Total clients: ${(userSession.transcripts as any).sseClients.size}`)

  // Start heartbeat interval to keep connection alive
  const heartbeatInterval = setInterval(() => {
    if (!isAlive) {
      clearInterval(heartbeatInterval)
      return
    }
    try {
      // Send heartbeat as SSE comment (: prefix) and as data message
      res.write(`: heartbeat ${Date.now()}\n`)
      res.write(`data: ${JSON.stringify({type: "heartbeat", timestamp: Date.now()})}\n\n`)
    } catch {
      // Client disconnected
      isAlive = false
      clearInterval(heartbeatInterval)
      userSession.transcripts.removeSSEClient(client)
    }
  }, SSE_HEARTBEAT_INTERVAL_MS)

  // Cleanup on disconnect
  req.on("close", () => {
    console.log(`[SSE] Connection closed for user ${userId}`)
    console.log(`[SSE] Clients before removal: ${(userSession.transcripts as any).sseClients.size}`)
    isAlive = false
    clearInterval(heartbeatInterval)
    userSession.transcripts.removeSSEClient(client)
    console.log(`[SSE] Clients after removal: ${(userSession.transcripts as any).sseClients.size}`)
  })

  // Also handle error event
  req.on("error", (err) => {
    console.log(`[SSE] Connection error for user ${userId}:`, err)
    isAlive = false
    clearInterval(heartbeatInterval)
    userSession.transcripts.removeSSEClient(client)
  })
})

// ============================================
// Proxy: Forward unmatched routes to Bun
// ============================================
expressApp.all("*", async (req, res) => {
  try {
    const bunUrl = `http://localhost:${BUN_PORT}${req.originalUrl || req.url}`

    // Debug logging for API requests
    if (req.originalUrl?.startsWith("/api/")) {
      const authReq = req as any
      console.log(`[PROXY] ${req.method} ${req.originalUrl} - authUserId: ${authReq.authUserId || "NONE"}`)
    }

    // Build headers - forward existing headers AND add auth info
    const proxyHeaders: Record<string, string> = {}

    // Copy existing headers
    Object.entries(req.headers).forEach(([key, value]) => {
      if (value) {
        proxyHeaders[key] = Array.isArray(value) ? value.join(", ") : value
      }
    })

    // Forward authenticated user from Express middleware to Bun
    const authReq = req as any
    if (authReq.authUserId) {
      proxyHeaders["x-auth-user-id"] = authReq.authUserId
    }

    if (authReq.activeSession) {
      proxyHeaders["x-has-active-session"] = "true"
    }

    // Proxy request to Bun
    const response = await fetch(bunUrl, {
      method: req.method,
      headers: proxyHeaders as HeadersInit,
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    })

    // Copy response headers
    response.headers.forEach((value, key) => {
      res.setHeader(key, value)
    })

    // Send response
    res.status(response.status)
    res.send(await response.text())
  } catch (error) {
    console.error("Proxy error:", error)
    res.status(500).send("Proxy error")
  }
})

console.log(`✅ MentraOS AppServer running at http://localhost:${PORT}`)
console.log(`   - Session endpoints: http://localhost:${PORT}/session-start`)
console.log(`   - Webhook: http://localhost:${PORT}/webhook`)
console.log(`   - Webview (proxied): http://localhost:${PORT}\n`)

console.log("🎉 Line Width Debug Tool is ready!")
console.log(`\n📝 Access the app at: http://localhost:${PORT}\n`)

// ============================================
// Graceful Shutdown
// ============================================

const shutdown = async () => {
  console.log("\n🛑 Shutting down...")
  lineWidthApp.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
