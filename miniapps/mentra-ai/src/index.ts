/**
 * Mentra AI - Fullstack Entry Point
 *
 * Uses Bun.serve() with HTML imports for the frontend
 * and Hono-based AppServer for the backend + MentraOS SDK.
 */

import { createMentraAIServer } from "./server/MentraAI";
import { api } from "./server/routes/routes";
import { createMentraAuthRoutes } from "@mentra/sdk";
import indexHtml from "./frontend/index.html";

// Configuration from environment
const PORT = parseInt(process.env.PORT || "3000", 10);
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const API_KEY = process.env.MENTRAOS_API_KEY;
const COOKIE_SECRET = process.env.COOKIE_SECRET || API_KEY;

// Validate required environment variables
if (!PACKAGE_NAME) {
  console.error("PACKAGE_NAME environment variable is not set");
  process.exit(1);
}

if (!API_KEY) {
  console.error("MENTRAOS_API_KEY environment variable is not set");
  process.exit(1);
}

console.log("🤖 Starting Mentra AI\n");
console.log(`   Package: ${PACKAGE_NAME}`);
console.log(`   Port: ${PORT}`);
console.log("");

// Initialize App (extends Hono via AppServer)
const app = await createMentraAIServer({
  packageName: PACKAGE_NAME,
  apiKey: API_KEY,
  port: PORT,
  cookieSecret: COOKIE_SECRET,
});

// Mount Mentra auth routes for frontend token exchange
app.route(
  "/api/mentra/auth",
  createMentraAuthRoutes({
    apiKey: API_KEY,
    packageName: PACKAGE_NAME,
    cookieSecret: COOKIE_SECRET || "",
  }),
);

// Mount API routes
// @ts-ignore - Hono type compatibility
app.route("/api", api);

// Start the SDK app (registers SDK routes, checks version)
await app.start();

console.log(`✅ Mentra AI running at http://localhost:${PORT}`);
console.log(`   • Webview: http://localhost:${PORT}`);
console.log(`   • API: http://localhost:${PORT}/api/health`);
console.log("");

// Determine environment
const isDevelopment = process.env.NODE_ENV === "development";

// Serve static assets
const publicPath = `${process.cwd()}/src/public/assets`;

// Start Bun server with HMR support
Bun.serve({
  port: PORT,
  idleTimeout: 120, // 2 minutes for SSE connections
  development: isDevelopment && {
    hmr: true,
    console: true,
  },
  routes: {
    // Serve the React frontend at root
    "/": indexHtml,
    "/webview": indexHtml,
    "/webview/*": indexHtml,
  },
  fetch(request) {
    const url = new URL(request.url);

    // Serve static assets from /assets/
    if (url.pathname.startsWith("/assets/")) {
      const filePath = `${publicPath}${url.pathname.replace("/assets", "")}`;
      const file = Bun.file(filePath);
      return new Response(file);
    }

    // Handle all other requests through Hono app
    return app.fetch(request);
  },
});

if (isDevelopment) {
  console.log(`🔥 HMR enabled for development`);
}
console.log("");

// Graceful shutdown
const shutdown = async () => {
  console.log("\n🛑 Shutting down Camera App...");
  await app.stop();
  console.log("👋 Goodbye!");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
