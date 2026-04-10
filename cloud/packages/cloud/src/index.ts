/**
 * @fileoverview MentraOS Cloud Server entry point (Hono + Bun native).
 * Initializes core services and sets up HTTP/WebSocket servers using Bun.serve().
 *
 * This is the new entry point using Hono for native Bun HTTP handling.
 *
 * IMPORTANT: This file explicitly calls Bun.serve() and does NOT use export default
 * to prevent Bun from auto-starting the server a second time. Bun auto-detects
 * `export default` with a `fetch` function and tries to call Bun.serve() on it,
 * which would cause EADDRINUSE errors.
 */

import dotenv from "dotenv";
dotenv.config();

// Safety net for unhandled promise rejections.
// Without this, Bun exits with code 1 on any unhandled rejection,
// killing all connected users. This logs the error and continues.
// Individual bugs should still be fixed — this is defense in depth.
// See: cloud/issues/068-resource-tracker-crash, cloud/issues/070-soniox-timeout-crash
process.on("unhandledRejection", (reason, _promise) => {
  console.error("[UNHANDLED REJECTION] Process NOT exiting:", reason);
  try {
    // Try to log via pino (may not be initialized yet if this fires early)
    const { logger } = require("./services/logging/pino-logger");
    logger.error(
      { err: reason, feature: "unhandled-rejection" },
      `Unhandled promise rejection (process NOT exiting): ${reason}`,
    );
  } catch {
    // Pino not ready — console.error above already captured it
  }
});

import mongoose from "mongoose";
import * as mongoConnection from "./connections/mongodb.connection";
import honoApp from "./hono-app";
import * as AppUptimeService from "./services/core/app-uptime.service";
import { appCache } from "./services/core/app-cache.service";
import { memoryTelemetryService } from "./services/debug/MemoryTelemetryService";
import { logger as rootLogger } from "./services/logging/pino-logger";
import { metricsService } from "./services/metrics";
import { systemVitalsLogger } from "./services/metrics/SystemVitalsLogger";
import { setShuttingDown } from "./services/shutdown";
import { udpAudioServer } from "./services/udp/UdpAudioServer";
import UserSession from "./services/session/UserSession";
import { handleUpgrade, websocketHandlers } from "./services/websocket/bun-websocket";
// import generateCoreToken from "./utils/generateCoreToken";

// Hono app with all routes

const logger = rootLogger.child({ service: "index" });

// Initialize MongoDB connection
mongoConnection
  .init()
  .then(async () => {
    logger.info("MongoDB connection initialized successfully");

    // Initialize app cache — loads all ~1,314 apps (~2MB) into memory.
    // Must happen after MongoDB connects and before server accepts connections.
    // See: cloud/issues/062-mongodb-latency/spec.md (B3)
    try {
      await appCache.initialize();
    } catch (error) {
      logger.error(error, "App cache initialization failed — hot-path queries will fall back to DB");
    }

    // Log admin emails from environment for debugging
    const adminEmails = process.env.ADMIN_EMAILS || "";
    logger.info("ENVIRONMENT VARIABLES CHECK:");
    logger.info(`- NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
    logger.info(`- ADMIN_EMAILS: "${adminEmails}"`);

    // Log additional environment details
    logger.info(`- Current working directory: ${process.cwd()}`);

    if (adminEmails) {
      const emails = adminEmails.split(",").map((e) => e.trim());
      logger.info(`Admin access configured for ${emails.length} email(s): [${emails.join(", ")}]`);
    } else {
      logger.warn("No ADMIN_EMAILS environment variable found. Admin panel will be inaccessible.");

      // For development, log a helpful message
      if (process.env.NODE_ENV === "development") {
        logger.info("Development mode: set ADMIN_EMAILS environment variable to enable admin access");
      }
    }
  })
  .catch((error) => {
    logger.error("MongoDB connection failed:", error);
  });

// Start UDP Audio Server
udpAudioServer
  .start()
  .then(() => {
    logger.info("UDP Audio Server started successfully on port 8000");
  })
  .catch((error) => {
    logger.error({ error }, "UDP Audio Server failed to start (continuing without UDP audio support)");
  });

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;

// Optional: Create legacy Express handler for routes not yet migrated
// Uncomment if you need Express fallback for specific routes
// const legacyExpressHandler = createLegacyExpressHandler();

// Routes that should fall back to Express (if enabled)
// These are routes that haven't been migrated to Hono yet
const LEGACY_EXPRESS_PATHS = [
  "/appsettings",
  "/tpasettings",
  "/api/dev",
  "/api/admin",
  "/api/orgs",
  "/api/photos",
  "/api/gallery",
  "/api/tools",
  "/api/permissions",
  "/api/hardware",
  "/api/account",
  "/api/onboarding",
  "/api/app-uptime",
  "/api/streams",
];

/**
 * Check if a path should fall back to Express
 */
function _shouldUseLegacyExpress(pathname: string): boolean {
  return LEGACY_EXPRESS_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

// Start Bun.serve() with native WebSocket support
const _server = Bun.serve({
  port: PORT,

  // Native Bun WebSocket handlers
  websocket: websocketHandlers,

  // HTTP request handler
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade requests
    if (
      url.pathname === "/glasses-ws" ||
      url.pathname === "/app-ws" ||
      url.pathname === "/ws/client" ||
      url.pathname === "/ws/miniapp"
    ) {
      const upgradeResult = handleUpgrade(req, server);
      if (upgradeResult === undefined) {
        // Upgrade successful
        return undefined as any;
      }
      // Return error response
      return upgradeResult;
    }

    // Optional: Fall back to legacy Express handler for unmigrated routes
    // Uncomment the block below if you need Express fallback
    /*
    if (shouldUseLegacyExpress(url.pathname)) {
      return legacyExpressHandler(req, server);
    }
    */

    // All HTTP requests handled by Hono
    return honoApp.fetch(req, { ip: server.requestIP(req) });
  },
});

// Start metrics service (event loop lag sampling, throughput tracking)
metricsService.start();

// Start system vitals logger (Golden Signals every 30s)
systemVitalsLogger.start();

// Start memory telemetry
memoryTelemetryService.start();

if (process.env.UPTIME_SERVICE_RUNNING === "true") {
  AppUptimeService.startUptimeScheduler();
}

logger.info(`\n
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
    ☁️☁️☁️      😎 MentraOS Cloud Server 🚀
    ☁️☁️☁️      🌐 Listening on port ${PORT} 🌐
    ☁️☁️☁️      ⚡ Pure Hono + Bun Native ⚡
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️\n`);

// ---------------------------------------------------------------------------
// Graceful shutdown on SIGTERM/SIGINT
// Sends WebSocket close frames to all connected clients so phones detect
// the disconnect immediately (<2s) instead of waiting for ping timeout (30-60s).
// See: cloud/issues/063-graceful-shutdown/spec.md
// ---------------------------------------------------------------------------

let isShutdownInProgress = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShutdownInProgress) return;
  isShutdownInProgress = true;
  setShuttingDown(); // shared flag — health check returns 503, new WS upgrades rejected

  logger.info({ signal }, `${signal} received — starting graceful shutdown`);

  // 1. Close all WebSocket connections with close frames
  const sessions = UserSession.getAllSessions();
  let closedGlasses = 0;
  let closedApps = 0;

  for (const session of sessions) {
    try {
      if (session.websocket) {
        session.websocket.close(1001, "Server shutting down");
        closedGlasses++;
      }
      if (session.appWebsockets) {
        for (const [, appWs] of session.appWebsockets) {
          try {
            appWs.close(1001, "Server shutting down");
            closedApps++;
          } catch {
            // WebSocket might already be closed
          }
        }
      }
    } catch (error) {
      logger.warn({ error, userId: session.userId }, "Error closing WebSocket during shutdown");
    }
  }

  logger.info(
    { closedGlasses, closedApps, totalSessions: sessions.length },
    `Closed ${closedGlasses} glasses + ${closedApps} app WebSockets`,
  );

  // 2. Stop timers and services
  try {
    systemVitalsLogger.stop();
    appCache.stop();
    metricsService.stop();
  } catch {
    // Timers might already be stopped
  }

  // 3. Close MongoDB connection
  try {
    await mongoose.connection.close();
    logger.info("MongoDB connection closed");
  } catch {
    // Connection might already be closed
  }

  // Wait 2 seconds for WebSocket close frames to flush to clients before exiting.
  // Without this delay, process.exit(0) can kill the runtime before Bun sends
  // the close handshake on the wire, making the shutdown look like a crash.
  logger.info("Graceful shutdown complete — waiting 2s for close frames to flush");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  logger.info("Draining complete — exiting");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Generate core token for debugging with postman.
// generateCoreToken
// (async () => {
//   const coreToken = await generateCoreToken("");
//   logger.debug(`Core Token:\n${coreToken}`);
// })();

// IMPORTANT: Do NOT add `export default server` here!
// Bun auto-detects default exports with a `fetch` function and calls Bun.serve() on them.
// Since we already called Bun.serve() above, this would cause EADDRINUSE (port already in use).
//
// If you need to export the server for testing, use a named export:
// export { server };
