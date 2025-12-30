/**
 * Captions App - Two Server Architecture
 *
 * Port 3334 (Bun)     - Serves React webview + custom API routes
 * Port 3333 (Express) - Handles MentraOS AppServer + proxies to Bun
 *
 * Flow:
 * - User visits localhost:3333 → Express proxies to Bun → Gets React app
 * - MentraOS Cloud calls /session-start → Express handles it
 * - Browser requests /api/hello → Express proxies to Bun
 */

import {serve} from "bun"
import {routes} from "./api/routes"
import index from "./webview/index.html"
import {CaptionsApp} from "./app/CaptionsApp"

// Configuration
const PORT = parseInt(process.env.PORT || "3333", 10)
const BUN_PORT = PORT + 1 // 3334
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mentra.captions"
const API_KEY = process.env.MENTRAOS_API_KEY || ""

if (!API_KEY) {
  console.error("❌ MENTRAOS_API_KEY environment variable is not set")
  process.exit(1)
}

if (!PACKAGE_NAME) {
  console.error("❌ PACKAGE_NAME environment variable is not set")
  process.exit(1)
}

console.log("🚀 Starting Captions App...\n")

// ============================================
// Step 1: Start Bun Server (Port 3334)
// ============================================

console.log(`📦 Starting Bun server on port ${BUN_PORT}...`)

const bunServer = serve({
  port: BUN_PORT,
  routes: {
    // Custom API routes
    ...routes,

    // Serve webview as fallback (Bun handles JSX/Tailwind automatically)
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
})

console.log(`✅ Bun server running at ${bunServer.url}`)
console.log(`   - Webview: ${bunServer.url}`)
console.log(`   - API: ${bunServer.url}/api/hello\n`)

// ============================================
// Step 2: Start Express/AppServer (Port 3333)
// ============================================

console.log(`📱 Starting MentraOS AppServer on port ${PORT}...`)

const captionsApp = new CaptionsApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
})

// Start AppServer first (registers all MentraOS routes)
await captionsApp.start()

// Get Express app instance AFTER starting (routes are registered)
const expressApp = captionsApp.getExpressApp()

// Add catch-all proxy as LAST route - only matches if no other route did
// This forwards any unmatched routes to Bun (webview, custom API)
expressApp.all("*", async (req, res) => {
  try {
    const bunUrl = `http://localhost:${BUN_PORT}${req.originalUrl || req.url}`

    // Proxy request to Bun
    const response = await fetch(bunUrl, {
      method: req.method,
      headers: req.headers as HeadersInit,
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

console.log("🎉 Captions app is ready!")
console.log(`\n📝 Access the app at: http://localhost:${PORT}\n`)

// ============================================
// Graceful Shutdown
// ============================================

const shutdown = async () => {
  console.log("\n🛑 Shutting down...")
  await captionsApp.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
