/**
 * @fileoverview Hono application entry point.
 * Native Bun HTTP handling without Express compatibility bridge.
 *
 * This file creates the Hono app with all middleware and routes configured.
 * It's designed to be used with Bun.serve() in index.ts.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import path from "path";

import { CORS_ORIGINS } from "./config/cors";
import { logger as rootLogger } from "./services/logging/pino-logger";
import { metricsService } from "./services/metrics";
import UserSession from "./services/session/UserSession";
import { udpAudioServer } from "./services/udp/UdpAudioServer";
import type { AppEnv } from "./types/hono";

// Hono API routes - organized by category
import {
  // Client APIs (mobile app and glasses client)
  audioConfigApi,
  livekitApi,
  minVersionApi,
  clientAppsApi,
  userSettingsApi,
  feedbackApi,
  calendarApi,
  locationApi,
  notificationsApi,
  deviceStateApi,
  // SDK APIs (third-party apps)
  sdkVersionApi,
  simpleStorageApi,
  // Public APIs (no auth required)
  publicPermissionsApi,
  // Console APIs (developer console)
  consoleAccountApi,
  consoleOrgsApi,
  consoleAppsApi,
  cliKeysApi,
  // Store APIs (MentraOS Store website)
  storeAppsApi,
  storeAuthApi,
  storeUserApi,
  // System App APIs (app management with API key auth)
  systemAppApi,
} from "./api/hono";

// Hono Legacy routes (migrated from Express)
import authRoutes from "./api/hono/routes/auth.routes";
import appsRoutes from "./api/hono/routes/apps.routes";
import appSettingsRoutes from "./api/hono/routes/app-settings.routes";
import adminRoutes from "./api/hono/routes/admin.routes";
import onboardingRoutes from "./api/hono/routes/onboarding.routes";
import permissionsRoutes from "./api/hono/routes/permissions.routes";
import photosRoutes from "./api/hono/routes/photos.routes";
import galleryRoutes from "./api/hono/routes/gallery.routes";

import streamsRoutes from "./api/hono/routes/streams.routes";
import hardwareRoutes from "./api/hono/routes/hardware.routes";
import toolsRoutes from "./api/hono/routes/tools.routes";
import accountRoutes from "./api/hono/routes/account.routes";
import appUptimeRoutes from "./api/hono/routes/app-uptime.routes";
import developerRoutes from "./api/hono/routes/developer.routes";
import organizationRoutes from "./api/hono/routes/organization.routes";
import audioRoutes, { textToSpeech } from "./api/hono/routes/audio.routes";
import errorReportRoutes from "./api/hono/routes/error-report.routes";
import transcriptsRoutes from "./api/hono/routes/transcripts.routes";
import appCommunicationRoutes from "./api/hono/routes/app-communication.routes";

// Hono middleware
import { authenticateConsole, authenticateCLI, transformCLIToConsole } from "./api/hono/middleware";

const logger = rootLogger.child({ service: "hono-app" });

// Create the main Hono app
const app = new Hono<AppEnv>();

// ============================================================================
// Global Middleware
// ============================================================================

// Security headers (replaces helmet)
app.use(secureHeaders());

// CORS (replaces cors package)
app.use(
  cors({
    origin: CORS_ORIGINS,
    credentials: true,
  }),
);

// Request logging middleware (replaces pino-http)
// Logs all HTTP requests to Better Stack with detailed information
app.use(async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const reqPath = c.req.path;
  const url = c.req.url;

  // Generate correlation ID (check for existing request ID header first)
  const reqId =
    c.req.header("x-request-id") ||
    c.req.header("x-correlation-id") ||
    `${method}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  // Store request ID in context for use in handlers
  c.set("reqId", reqId);

  // Skip detailed logging for noisy endpoints (but still process them)
  const isNoisyEndpoint = reqPath === "/health" || reqPath.startsWith("/api/livekit/token");

  // Capture request details before processing
  const userAgent = c.req.header("user-agent") || "unknown";
  const contentType = c.req.header("content-type");
  const contentLength = c.req.header("content-length");
  const referer = c.req.header("referer");
  const origin = c.req.header("origin");

  // Get client IP (check various headers for proxied requests)
  const clientIp =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip") ||
    "unknown";

  // Extract auth info (without exposing tokens)
  const hasAuth = !!c.req.header("authorization");
  const authType = c.req.header("authorization")?.split(" ")[0] || null;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;
  const responseContentType = c.res.headers.get("content-type");

  // Track HTTP request metrics for Prometheus / Porter dashboard
  metricsService.incrementHttpRequests(status);

  // Capture userId from auth middleware (populated during next())
  // This enables filtering by user in Better Stack
  const userId = c.get("email") || c.get("console")?.email || undefined;

  // Build comprehensive log data for Better Stack
  const logData = {
    // Request identification
    reqId,
    method,
    path: reqPath,
    url: new URL(url).pathname + new URL(url).search,

    // Response info
    status,
    duration,
    responseContentType,

    // Client info
    clientIp,
    userAgent,

    // Request metadata
    contentType,
    contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
    referer,
    origin,

    // Auth info (safe) - userId enables user-centric debugging in Better Stack
    hasAuth,
    authType,
    userId,

    // Categorization for Better Stack filtering
    service: "hono-http",
    feature: "http-request",
  };

  // Skip logging for noisy endpoints unless there's an error
  if (isNoisyEndpoint && status < 400) {
    return;
  }

  // Determine log level based on status code
  if (status >= 500) {
    logger.error(logData, `HTTP ${status} ${method} ${reqPath} [${duration}ms]`);
  } else if (status >= 400) {
    logger.warn(logData, `HTTP ${status} ${method} ${reqPath} [${duration}ms]`);
  } else {
    logger.info(logData, `HTTP ${status} ${method} ${reqPath} [${duration}ms]`);
  }
});

// ============================================================================
// Health Check
// ============================================================================

app.get("/health", (c) => {
  try {
    const activeSessions = UserSession.getAllSessions();

    // Update session gauges so metrics are fresh
    let miniappCount = 0;
    for (const session of activeSessions) {
      miniappCount += session.appWebsockets.size;
    }
    metricsService.setUserSessions(activeSessions.length);
    metricsService.setMiniappSessions(miniappCount);

    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      ...metricsService.toJSON(),
    });
  } catch (error) {
    logger.error(error, "Health check error");
    return c.json(
      {
        status: "error",
        error: "Health check failed",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

// ============================================================================
// Prometheus Metrics Endpoint (for Porter dashboard + custom autoscaling)
// ============================================================================

app.get("/metrics", (c) => {
  try {
    // Update session gauges before generating output
    const activeSessions = UserSession.getAllSessions();
    let miniappCount = 0;
    for (const session of activeSessions) {
      miniappCount += session.appWebsockets.size;
    }
    metricsService.setUserSessions(activeSessions.length);
    metricsService.setMiniappSessions(miniappCount);

    return c.text(metricsService.toPrometheus(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  } catch (error) {
    logger.error(error, "Metrics endpoint error");
    return c.text("# error generating metrics\n", 500);
  }
});

// ============================================================================
// Client API Routes (Hono native)
// ============================================================================

app.route("/api/client/livekit", livekitApi);
app.route("/api/client/min-version", minVersionApi);
app.route("/api/client/apps", clientAppsApi);
app.route("/api/client/user/settings", userSettingsApi);
app.route("/api/client/feedback", feedbackApi);
app.route("/api/client/calendar", calendarApi);
app.route("/api/client/location", locationApi);
app.route("/api/client/notifications", notificationsApi);
app.route("/api/client/device/state", deviceStateApi);
app.route("/api/client/audio/configure", audioConfigApi);

// ============================================================================
// SDK API Routes (Hono native)
// ============================================================================

app.route("/api/sdk/version", sdkVersionApi);
app.route("/api/sdk", sdkVersionApi); // Also mount at /api/sdk for backwards compat
app.route("/api/sdk/simple-storage", simpleStorageApi);

// ============================================================================
// Public API Routes (no auth required)
// ============================================================================

app.route("/api/public/permissions", publicPermissionsApi);

// ============================================================================
// Console API Routes (with console auth middleware)
// ============================================================================

// Create a sub-app for console routes with auth middleware
const consoleRouter = new Hono<AppEnv>();
consoleRouter.use("*", authenticateConsole);
consoleRouter.route("/account", consoleAccountApi);
consoleRouter.route("/orgs", consoleOrgsApi);
consoleRouter.route("/apps", consoleAppsApi);
consoleRouter.route("/cli-keys", cliKeysApi);
app.route("/api/console", consoleRouter);

// ============================================================================
// CLI API Routes (with CLI auth middleware, reusing console handlers)
// ============================================================================

const cliRouter = new Hono<AppEnv>();
cliRouter.use("*", authenticateCLI);
cliRouter.use("*", transformCLIToConsole);
cliRouter.route("/apps", consoleAppsApi);
cliRouter.route("/orgs", consoleOrgsApi);
app.route("/api/cli", cliRouter);

// ============================================================================
// Store API Routes (MentraOS Store website)
// ============================================================================

// Store routes handle their own auth internally (mixed public/authenticated)
app.route("/api/store", storeAppsApi);
app.route("/api/store/auth", storeAuthApi);
app.route("/api/store/user", storeUserApi);

// ============================================================================
// System App API Routes (app management with API key auth)
// ============================================================================

app.route("/api/sdk/system-app", systemAppApi);

// ============================================================================
// Legacy Routes (migrated from Express)
// ============================================================================

// Auth routes
app.route("/api/auth", authRoutes);
app.route("/auth", authRoutes);

// Apps routes
app.route("/api/apps", appsRoutes);
app.route("/apps", appsRoutes);

// App settings routes
app.route("/appsettings", appSettingsRoutes);
app.route("/tpasettings", appSettingsRoutes);

// Admin routes
app.route("/api/admin", adminRoutes);

// Onboarding routes
app.route("/api/onboarding", onboardingRoutes);

// Permissions routes
app.route("/api/permissions", permissionsRoutes);

// Photos routes
app.route("/api/photos", photosRoutes);

// Gallery routes
app.route("/api/gallery", galleryRoutes);

// Streams routes
app.route("/api/streams", streamsRoutes);

// Hardware routes
app.route("/api/hardware", hardwareRoutes);

// Tools routes
app.route("/api/tools", toolsRoutes);

// Account routes
app.route("/api/account", accountRoutes);

// App uptime routes
app.route("/api/app-uptime", appUptimeRoutes);

// Developer routes
app.route("/api/dev", developerRoutes);

// Organization routes (legacy)
app.route("/api/orgs", organizationRoutes);

// Audio routes
app.route("/api/audio", audioRoutes);

// TTS route (backwards compatibility - SDK calls /api/tts directly)
app.get("/api/tts", textToSpeech);

// Error report routes
app.route("/", errorReportRoutes);

// Transcripts routes
app.route("/api/transcripts", transcriptsRoutes);

// App communication routes
app.route("/api/app-communication", appCommunicationRoutes);

// ============================================================================
// Static Files
// ============================================================================

// Serve uploaded photos (specific path)
// Note: For production, consider using nginx or CDN for static files
app.get("/uploads/*", async (c) => {
  const filePath = c.req.path;
  const fullPath = path.join(__dirname, "..", filePath);

  try {
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      return new Response(file);
    }
    return c.json({ error: "File not found" }, 404);
  } catch (_error) {
    return c.json({ error: "Error serving file" }, 500);
  }
});

// ============================================================================
// Error Handling
// ============================================================================

app.onError((err, c) => {
  logger.error(err, "Unhandled error in request handler");

  // Don't expose internal error details in production
  const isProduction = process.env.NODE_ENV === "production";

  return c.json(
    {
      error: "Internal server error",
      message: isProduction ? "An unexpected error occurred" : err.message,
      timestamp: new Date().toISOString(),
    },
    500,
  );
});

// 404 handler
app.notFound((c) => {
  const path = c.req.path;

  // Check if this might be a legacy route that hasn't been migrated
  // All routes have been migrated to Hono
  const legacyPrefixes: string[] = [];

  const isLegacyRoute = legacyPrefixes.some((prefix) => path === prefix || path.startsWith(prefix + "/"));

  if (isLegacyRoute) {
    logger.warn({ path }, "Request to legacy route not yet migrated to Hono");
    return c.json(
      {
        error: "Route not yet migrated",
        message: "This endpoint is being migrated. Please try again later or contact support.",
        path,
        timestamp: new Date().toISOString(),
      },
      501,
    );
  }

  return c.json(
    {
      error: "Not found",
      path,
      timestamp: new Date().toISOString(),
    },
    404,
  );
});

export default app;
