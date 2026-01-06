/**
 * Photo Test App - Continuously takes photos and displays them in webview
 *
 * Port 3334 (Bun)     - Serves React webview + API routes
 * Port 3333 (Express) - Handles MentraOS AppServer + proxies to Bun
 */

import {serve} from "bun"

import {routes} from "./api/routes"
import {PhotoTestApp} from "./app"
import indexDev from "./webview/index.html"
import indexProd from "./webview/index.prod.html"

// Configuration
const PORT = parseInt(process.env.PORT || "3333", 10)
const BUN_PORT = PORT + 1 // 3334
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.mentra.photo-test"
const API_KEY = process.env.MENTRAOS_API_KEY || ""

if (!API_KEY) {
  console.error("❌ MENTRAOS_API_KEY environment variable is not set")
  process.exit(1)
}

if (!PACKAGE_NAME) {
  console.error("❌ PACKAGE_NAME environment variable is not set")
  process.exit(1)
}

console.log("🚀 Starting Photo Test App...\n")

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
    ...routes,
    "/*": isDevelopment ? indexDev : indexProd,
  },
})

console.log(`✅ Bun server running at ${bunServer.url}`)

// ============================================
// Step 2: Start Express/AppServer (Port 3333)
// ============================================

console.log(`📱 Starting MentraOS AppServer on port ${PORT}...`)

const photoTestApp = new PhotoTestApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
})

await photoTestApp.start()

const expressApp = photoTestApp.getExpressApp()

// ============================================
// Proxy: Forward unmatched routes to Bun
// ============================================

expressApp.all("*", async (req, res) => {
  try {
    const bunUrl = `http://localhost:${BUN_PORT}${req.originalUrl || req.url}`

    const proxyHeaders: Record<string, string> = {}

    Object.entries(req.headers).forEach(([key, value]) => {
      if (value) {
        proxyHeaders[key] = Array.isArray(value) ? value.join(", ") : value
      }
    })

    const authReq = req as any
    if (authReq.authUserId) {
      proxyHeaders["x-auth-user-id"] = authReq.authUserId
    }

    const response = await fetch(bunUrl, {
      method: req.method,
      headers: proxyHeaders as HeadersInit,
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body) : undefined,
    })

    response.headers.forEach((value, key) => {
      res.setHeader(key, value)
    })

    res.status(response.status)
    res.send(await response.text())
  } catch (error) {
    console.error("Proxy error:", error)
    res.status(500).send("Proxy error")
  }
})

console.log(`✅ MentraOS AppServer running at http://localhost:${PORT}`)
console.log(`\n📸 Photo Test app is ready!`)
console.log(`\n📝 Access the app at: http://localhost:${PORT}\n`)

// ============================================
// Graceful Shutdown
// ============================================

const shutdown = async () => {
  console.log("\n🛑 Shutting down...")
  photoTestApp.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
