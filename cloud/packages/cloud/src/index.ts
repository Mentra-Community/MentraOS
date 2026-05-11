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

logger.info(
  {
    feature: "process-lifecycle",
    event: "process-started",
    pid: process.pid,
    bunVersion: Bun.version,
    port: PORT,
  },
  "Process lifecycle: started",
);

// ---------------------------------------------------------------------------
// Fail-fast shutdown on SIGTERM/SIGINT
//
// Goals (in priority order):
//   1. Every connected WebSocket receives a close frame (1001) so the phone
//      detects the disconnect immediately instead of waiting for ping timeout.
//   2. Exit the process within SHUTDOWN_BUDGET_MS (5 s).
//   3. Everything else — Mongo close, timer stopping, session dispose — is
//      either irrelevant (process is dying) or best-effort.
//
// Why synchronous stderr for announce/complete lines:
//   Pino is async-buffered. In prod, the "SIGTERM received" line from the
//   previous graceful-shutdown implementation (issue 063) never appeared in
//   BetterStack across 7 days of pod restarts, because logger.info returns
//   before the log reaches the transport and process.exit kills the runtime
//   before the buffer flushes. Synchronous stderr is guaranteed to leave
//   the pod before exit.
//
// See: cloud/issues/100-fail-fast-sigterm/spec.md
//      cloud/issues/063-graceful-shutdown/ (superseded)
// ---------------------------------------------------------------------------

const SHUTDOWN_BUDGET_MS = 5000;
const PINO_FLUSH_TIMEOUT_MS = 500;

let isShutdownInProgress = false;

function shutdownStderrLine(fields: Record<string, unknown>): void {
  // Synchronous write. Bypasses Pino. Guaranteed to leave the pod before exit.
  try {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n");
  } catch {
    // stderr write failed; nothing useful we can do.
  }
}

async function flushPinoWithTimeout(ms: number): Promise<"flushed" | "timeout" | "noop"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, ms);
    timer.unref();

    try {
      // Pino exposes .flush(cb) on supported transports. Best-effort: if the API
      // is unavailable we fall through to the timer.
      const anyLogger = logger as unknown as {
        flush?: (cb?: (err?: Error) => void) => void;
      };
      if (typeof anyLogger.flush === "function") {
        anyLogger.flush(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve("flushed");
        });
      } else {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve("noop");
      }
    } catch {
      // Fall through to the timer.
    }
  });
}

async function failFastShutdown(signal: string): Promise<void> {
  if (isShutdownInProgress) return;
  isShutdownInProgress = true;

  const t0 = Date.now();

  // Shared flag: health check returns 503, new WS upgrades rejected.
  setShuttingDown();

  // Watchdog: if anything hangs, force-exit at the budget with a distinct code.
  const watchdog = setTimeout(() => {
    shutdownStderrLine({
      feature: "process-lifecycle",
      event: "shutdown-watchdog-fired",
      signal,
      budgetMs: SHUTDOWN_BUDGET_MS,
      elapsedMs: Date.now() - t0,
    });

    process.exit(1);
  }, SHUTDOWN_BUDGET_MS);
  watchdog.unref();

  // Step 1: announce via synchronous stderr (Pino logs may not flush in time).
  const sessions = UserSession.getAllSessions();
  shutdownStderrLine({
    feature: "process-lifecycle",
    event: "shutdown-started",
    signal,
    pid: process.pid,
    sessionCount: sessions.length,
  });

  // Step 2: close every WebSocket with code 1001. Per-socket try/catch so one
  // bad close does not abort the loop. No await — close frames are queued by
  // Bun's TCP stack and delivered on socket teardown.
  let closedGlasses = 0;
  let closedApps = 0;
  for (const session of sessions) {
    try {
      session.websocket?.close(1001, "Server shutting down");
      closedGlasses++;
    } catch {
      // swallow per-socket
    }
    try {
      const appWsMap = session.appWebsockets;
      if (appWsMap) {
        for (const [, appWs] of appWsMap) {
          try {
            appWs.close(1001, "Server shutting down");
            closedApps++;
          } catch {
            // swallow per-socket
          }
        }
      }
    } catch {
      // swallow per-session (getter / iteration failure must not abort the loop)
    }
  }

  // Step 3: fire-and-forget Mongo close. The server sees a TCP FIN and cleans
  // up on its side; we do not block on mongoose's close handshake.
  try {
    void mongoose.connection.close();
  } catch {
    // swallow
  }

  // Step 4: flush Pino with a short timeout so previously-buffered structured
  // log lines have a chance to make it out.
  const flushResult = await flushPinoWithTimeout(PINO_FLUSH_TIMEOUT_MS);

  // Step 5: announce completion via synchronous stderr.
  shutdownStderrLine({
    feature: "process-lifecycle",
    event: "shutdown-complete",
    signal,
    elapsedMs: Date.now() - t0,
    closedGlasses,
    closedApps,
    pinoFlush: flushResult,
  });

  clearTimeout(watchdog);

  process.exit(0);
}

process.on("SIGTERM", () => void failFastShutdown("SIGTERM"));
process.on("SIGINT", () => void failFastShutdown("SIGINT"));

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
