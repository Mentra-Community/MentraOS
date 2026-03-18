/**
 * MentraOS Photo Test App - Fullstack Entry Point
 *
 * Uses Bun.serve() with HTML imports for the frontend
 * and Hono-based AppServer for the backend + MentraOS SDK.
 *
 * Tests photo request flows end-to-end (OS-947/OS-951).
 */

import {PhotoTestApp} from "./backend/PhotoTestApp"
import {api} from "./backend/api"
import {createMentraAuthRoutes} from "@mentra/sdk"
import indexHtml from "./frontend/index.html"

// Configuration from environment
const PORT = parseInt(process.env.PORT || "3000", 10)
const PACKAGE_NAME = process.env.PACKAGE_NAME
const API_KEY = process.env.MENTRAOS_API_KEY
const COOKIE_SECRET = process.env.COOKIE_SECRET || API_KEY

// Validate required environment variables
if (!PACKAGE_NAME) {
  console.error("PACKAGE_NAME environment variable is not set")
  process.exit(1)
}

if (!API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set")
  process.exit(1)
}

// Initialize App (extends Hono via AppServer)
const app = new PhotoTestApp({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  cookieSecret: COOKIE_SECRET,
})

// Mount Mentra auth routes for webview token exchange
app.route(
  "/api/mentra/auth",
  createMentraAuthRoutes({
    apiKey: API_KEY,
    packageName: PACKAGE_NAME,
    cookieSecret: COOKIE_SECRET || "",
  }),
)

// Mount API routes
// @ts-ignore - Hono type compatibility
app.route("/api", api)

// Start the SDK app (registers SDK routes, checks version)
await app.start()

console.log(`📸 Photo Test app running at http://localhost:${PORT}`)

// Determine environment
const isDevelopment = process.env.NODE_ENV === "development"

// Start Bun server with HMR support
Bun.serve({
  port: PORT,
  idleTimeout: 255, // Max value — prevents Bun from killing SSE connections (default is 10s)
  development: isDevelopment && {
    hmr: true,
    console: true,
  },
  routes: {
    "/": indexHtml,
    "/webview": indexHtml,
    "/webview/*": indexHtml,
  },
  fetch(request: Request) {
    // Handle all other requests through Hono app
    return app.fetch(request)
  },
} as any)

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...")
  await app.stop()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
