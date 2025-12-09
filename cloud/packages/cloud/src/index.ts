/**
 * @fileoverview AugmentOS Cloud Server entry point.
 * Initializes core services and sets up HTTP/WebSocket servers.
 */

import { Server } from "http";
import path from "path";

import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
dotenv.config();

import { registerApi } from "./api";
import * as mongoConnection from "./connections/mongodb.connection";
import * as AppUptimeService from "./services/core/app-uptime.service";
import { memoryTelemetryService } from "./services/debug/MemoryTelemetryService";
import { DebugService } from "./services/debug/debug-service";
import { logger as rootLogger } from "./services/logging/pino-logger";
import UserSession from "./services/session/UserSession";
import { websocketService } from "./services/websocket/websocket.service";

const logger = rootLogger.child({ service: "index" });

// Initialize MongoDB connection
mongoConnection
  .init()
  .then(() => {
    logger.info("MongoDB connection initialized successfully");

    // Log admin emails from environment for debugging
    const adminEmails = process.env.ADMIN_EMAILS || "";
    logger.info("ENVIRONMENT VARIABLES CHECK:");
    logger.info(`- NODE_ENV: ${process.env.NODE_ENV || "not set"}`);
    logger.info(`- ADMIN_EMAILS: "${adminEmails}"`);

    // Log additional environment details
    logger.info(`- Current working directory: ${process.cwd()}`);

    if (adminEmails) {
      const emails = adminEmails.split(",").map((e) => e.trim());
      logger.info(
        `Admin access configured for ${emails.length} email(s): [${emails.join(
          ", ",
        )}]`,
      );
    } else {
      logger.warn(
        "No ADMIN_EMAILS environment variable found. Admin panel will be inaccessible.",
      );

      // For development, log a helpful message
      if (process.env.NODE_ENV === "development") {
        logger.info(
          "Development mode: set ADMIN_EMAILS environment variable to enable admin access",
        );
      }
    }
  })
  .catch((error) => {
    logger.error("MongoDB connection failed:", error);
  });

// Initialize Express and HTTP server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80; // Default http port.
const app = express();
const server = new Server(app);

// Initialize services in the correct order
const debugService = new DebugService(server);

// Export services for use in other modules
export { debugService, websocketService };

// Middleware setup
app.use(helmet());
app.use(
  cors({
    credentials: true,
    origin: [
      "*",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://127.0.0.1:5174",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:5173",
      "http://localhost:53216",
      "http://localhost:6173",
      "http://localhost:8052",
      "https://cloud.augmentos.org",
      "https://dev.augmentos.org",
      "https://devold.augmentos.org",
      "https://www.augmentos.org",
      "https://augmentos.org",
      "https://augmentos.dev",

      // AugmentOS App Store / Developer Portal
      "https://augmentos.dev",
      "https://appstore.augmentos.dev",

      "https://dev.appstore.augmentos.dev",
      "https://dev.augmentos.dev",
      "https://staging.appstore.augmentos.dev",
      "https://staging.augmentos.dev",
      "https://prod.appstore.augmentos.dev",
      "https://prod.augmentos.dev",

      "https://augmentos-developer-portal.netlify.app",

      "https://appstore.augmentos.org",
      "https://store.augmentos.org",
      "https://storedev.augmentos.org",
      "https://console.augmentos.org",
      "https://consoledev.augmentos.org",
      "https://account.augmentos.org",
      "https://accountdev.augmentos.org",
      "https://docsdev.augmentos.org",

      "https://augmentos.pages.dev",
      "https://augmentos-appstore-2.pages.dev",

      // ngrok development tunnels
      "https://webview.ngrok.dev",
      "https://mentra-cloud-server.ngrok.app",

      // mentra.glass API
      "https://mentra.glass",
      "https://api.mentra.glass",
      "https://dev.api.mentra.glass",
      "https://uscentral.api.mentra.glass",
      "https://france.api.mentra.glass",
      "https://asiaeast.api.mentra.glass",

      "https://apps.mentra.glass",
      "https://console.mentra.glass",
      "https://dev.mentra.glass",
      "https://account.mentra.glass",
      "https://docs.mentra.glass",
      "https://store.mentra.glass",

      "https://appsdev.mentra.glass",
      "https://consoledev.mentra.glass",
      "https://accountdev.mentra.glass",
      "https://docsdev.mentra.glass",
      "https://storedev.mentra.glass",

      "https://dev.apps.mentra.glass",
      "https://dev.console.mentra.glass",
      "https://dev.account.mentra.glass",
      "https://dev.docs.mentra.glass",
      "https://dev.store.mentra.glass",

      // mentraglass.com API
      "https://www.mentraglass.com",
      "https://api.mentraglass.com",
      "https://devapi.mentraglass.com",
      "https://uscentralapi.mentraglass.com",
      "https://franceapi.mentraglass.com",
      "https://asiaeastapi.mentraglass.com",

      "https://apps.mentraglass.com",
      "https://console.mentraglass.com",
      "https://account.mentraglass.com",
      "https://docs.mentraglass.com",
      "https://store.mentraglass.com",
      "https://dev.mentraglass.com",

      "https://appsdev.mentraglass.com",
      "https://consoledev.mentraglass.com",
      "https://accountdev.mentraglass.com",
      "https://docsdev.mentraglass.com",
      "https://storedev.mentraglass.com",

      "https://appsbeta.mentraglass.com",
      "https://consolebeta.mentraglass.com",
      "https://accountbeta.mentraglass.com",

      "https://dev.apps.mentraglass.com",
      "https://dev.console.mentraglass.com",
      "https://dev.account.mentraglass.com",
      "https://dev.docs.mentraglass.com",
      "https://dev.store.mentraglass.com",

      // China Endpoints
      "https://www.mentraglass.cn",
      "https://api.mentraglass.cn",

      "https://console.mentraglass.cn",
      "https://account.mentraglass.cn",
      "https://store.mentraglass.cn",
    ],
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cookieParser());

// Add pino-http middleware for request logging
app.use(
  pinoHttp({
    logger: rootLogger,
    genReqId: (req) => {
      // Generate correlation ID for each request
      return `${req.method}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 11)}`;
    },
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 400 && res.statusCode < 500) return "warn";
      if (res.statusCode >= 500 || err) return "error";
      return "info";
    },
    customSuccessMessage: (req, res) => {
      return `${req.method} ${req.url} - ${res.statusCode}`;
    },
    customErrorMessage: (req, res, err) => {
      return `${req.method} ${req.url} - ${res.statusCode} - ${err.message}`;
    },
    // Reduce verbosity in development by excluding request/response details
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        // Only include basic info, skip headers/body/params for cleaner logs
      }),
      res: (res) => ({
        statusCode: res.statusCode,
        // Skip verbose response headers
      }),
    },
    // Don't log noisy or frequent requests
    autoLogging: {
      ignore: (req) => {
        // Skip health checks, livekit token requests, and other noisy endpoints
        return (
          req.url === "/health" ||
          req.url === "/api/livekit/token" ||
          req.url?.startsWith("/api/livekit/token")
        );
      },
    },
  }),
);

// Routes
registerApi(app);

// app.use('/api/app-communication', appCommunicationRoutes);
// app.use('/api/tpa-communication', appCommunicationRoutes); // TODO: Remove this once the old apps are fully updated in the wild (the old mobile clients will hit the old urls)

// Health check endpoint
app.get("/health", (req, res) => {
  try {
    const activeSessions = UserSession.getAllSessions();

    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      sessions: {
        activeCount: activeSessions.length,
      },
      uptime: process.uptime(),
    });
  } catch (error) {
    console.error("Health check error:", error);
    res.status(500).json({
      status: "error",
      error: "Health check failed",
      timestamp: new Date().toISOString(),
    });
  }
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "./public")));

// Serve uploaded photos
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Initialize WebSocket service
// Initialize WebSocket servers
websocketService.setupWebSocketServers(server);

// Start memory telemetry
memoryTelemetryService.start();

if (process.env.UPTIME_SERVICE_RUNNING === "true") {
  AppUptimeService.startUptimeScheduler(); // start app uptime service scheduler
}

// Start the server
try {
  server.listen(PORT, () => {
    logger.info(`\n
        ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
        ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
        ☁️☁️☁️      😎 MentraOS Cloud Server 🚀
        ☁️☁️☁️      🌐 Listening on port ${PORT} 🌐
        ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
        ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️\n`);
  });
} catch (error) {
  logger.error(error, "Failed to start server:");
}

export default server;
