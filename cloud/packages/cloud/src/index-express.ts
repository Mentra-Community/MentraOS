/**
 * @fileoverview AugmentOS Cloud Server entry point.
 * Initializes core services and sets up HTTP/WebSocket servers using Bun.serve().
 */

import path from "path";
import { Readable } from "stream";

import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
dotenv.config();

import { registerApi } from "./api";
import { CORS_ORIGINS } from "./config/cors";
import * as mongoConnection from "./connections/mongodb.connection";
import * as AppUptimeService from "./services/core/app-uptime.service";
import { memoryTelemetryService } from "./services/debug/MemoryTelemetryService";
import { logger as rootLogger } from "./services/logging/pino-logger";
import UserSession from "./services/session/UserSession";
import { handleUpgrade, websocketHandlers } from "./services/websocket/bun-websocket";

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

// Initialize Express app (for HTTP routes)
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;
const expressApp = express();

// Middleware setup
expressApp.use(helmet());
expressApp.use(
  cors({
    credentials: true,
    origin: CORS_ORIGINS,
  }),
);

expressApp.use(express.json({ limit: "50mb" }));
expressApp.use(express.urlencoded({ limit: "50mb", extended: true }));
expressApp.use(cookieParser());

// Add pino-http middleware for request logging
expressApp.use(
  pinoHttp({
    logger: rootLogger as any,
    genReqId: (req) => {
      // Generate correlation ID for each request
      return `${req.method}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
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
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
    // Don't log noisy or frequent requests
    autoLogging: {
      ignore: (req) => {
        return req.url === "/health" || req.url === "/api/livekit/token" || req.url?.startsWith("/api/livekit/token");
      },
    },
  }),
);

// Routes
registerApi(expressApp);

// Health check endpoint
expressApp.get("/health", (req, res) => {
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
expressApp.use(express.static(path.join(__dirname, "./public")));

// Serve uploaded photos
expressApp.use("/uploads", express.static(path.join(__dirname, "../uploads")));

/**
 * Create a proper Node.js IncomingMessage-like object from a Bun Request.
 * This uses Node's actual Readable stream to ensure compatibility with body-parser.
 */
function createNodeRequest(req: Request, url: URL, bodyBuffer: Buffer | null, clientIP: string): any {
  // Create a proper Readable stream from the body buffer
  const readable = new Readable({
    read() {
      if (bodyBuffer && bodyBuffer.length > 0) {
        this.push(bodyBuffer);
      }
      this.push(null); // Signal end of stream
    },
  });

  // Add IncomingMessage properties to the Readable stream
  const nodeReq = readable as any;

  nodeReq.method = req.method;
  nodeReq.url = url.pathname + url.search;
  nodeReq.headers = {} as Record<string, string>;
  nodeReq.httpVersion = "1.1";
  nodeReq.httpVersionMajor = 1;
  nodeReq.httpVersionMinor = 1;
  nodeReq.complete = false;
  nodeReq.aborted = false;
  nodeReq.upgrade = false;

  // Create mock socket
  const mockSocket = {
    remoteAddress: clientIP,
    remotePort: 0,
    localAddress: "127.0.0.1",
    localPort: PORT,
    destroy: () => {},
    end: () => {},
    write: () => true,
    setTimeout: () => mockSocket,
    setNoDelay: () => mockSocket,
    setKeepAlive: () => mockSocket,
    ref: () => mockSocket,
    unref: () => mockSocket,
    encrypted: false,
    writable: true,
    readable: true,
    on: () => mockSocket,
    once: () => mockSocket,
    off: () => mockSocket,
    emit: () => false,
    removeListener: () => mockSocket,
  };

  nodeReq.socket = mockSocket;
  nodeReq.connection = mockSocket;

  // Copy headers from Bun Request
  req.headers.forEach((value, key) => {
    nodeReq.headers[key.toLowerCase()] = value;
  });

  return nodeReq;
}

/**
 * Create a mock ServerResponse that collects the response and resolves a Promise with a Bun Response.
 */
function createNodeResponse(resolve: (response: Response) => void): any {
  const responseBody: Buffer[] = [];
  const responseHeaders: Record<string, string | string[]> = {};
  let statusCode = 200;

  const mockSocket = {
    writable: true,
    on: () => mockSocket,
    once: () => mockSocket,
    off: () => mockSocket,
    emit: () => false,
    removeListener: () => mockSocket,
  };

  const nodeRes: any = {
    socket: mockSocket,
    connection: mockSocket,
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    finished: false,
    writable: true,
    _header: null,
    _headerSent: false,

    writeHead(code: number, reasonOrHeaders?: string | Record<string, any>, headers?: Record<string, any>) {
      statusCode = code;
      nodeRes.statusCode = code;
      const h = typeof reasonOrHeaders === "object" ? reasonOrHeaders : headers;
      if (h) {
        for (const [key, value] of Object.entries(h)) {
          responseHeaders[key.toLowerCase()] = value as string;
        }
      }
      nodeRes.headersSent = true;
      nodeRes._headerSent = true;
      return nodeRes;
    },

    setHeader(name: string, value: string | string[]) {
      responseHeaders[name.toLowerCase()] = value;
      return nodeRes;
    },

    getHeader(name: string) {
      return responseHeaders[name.toLowerCase()];
    },

    removeHeader(name: string) {
      delete responseHeaders[name.toLowerCase()];
    },

    hasHeader(name: string) {
      return name.toLowerCase() in responseHeaders;
    },

    getHeaders() {
      return { ...responseHeaders };
    },

    getHeaderNames() {
      return Object.keys(responseHeaders);
    },

    write(chunk: Buffer | string, encoding?: BufferEncoding | (() => void), callback?: () => void) {
      if (typeof encoding === "function") {
        callback = encoding;
      }
      responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (callback) callback();
      return true;
    },

    end(chunk?: Buffer | string | (() => void), encoding?: BufferEncoding | (() => void), callback?: () => void) {
      if (typeof chunk === "function") {
        callback = chunk;
        chunk = undefined;
      } else if (typeof encoding === "function") {
        callback = encoding;
      }

      if (chunk) {
        responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }

      nodeRes.finished = true;
      nodeRes.writable = false;

      const body = Buffer.concat(responseBody);
      const headers = new Headers();

      for (const [key, value] of Object.entries(responseHeaders)) {
        if (Array.isArray(value)) {
          value.forEach((v) => headers.append(key, v));
        } else if (value) {
          headers.set(key, value as string);
        }
      }

      if (callback) callback();

      resolve(
        new Response(body.length > 0 ? body : null, {
          status: statusCode,
          headers,
        }),
      );
    },

    flushHeaders() {},
    addTrailers() {},
    writeContinue() {},
    assignSocket() {},
    detachSocket() {},
    cork() {},
    uncork() {},

    // Event emitter methods (no-ops for compatibility)
    on: () => nodeRes,
    once: () => nodeRes,
    off: () => nodeRes,
    emit: () => false,
    removeListener: () => nodeRes,
    addListener: () => nodeRes,
  };

  return nodeRes;
}

// Start Bun.serve() with native WebSocket support
const server = Bun.serve({
  port: PORT,

  // Native Bun WebSocket handlers
  websocket: websocketHandlers,

  // HTTP request handler
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade requests
    if (url.pathname === "/glasses-ws" || url.pathname === "/app-ws") {
      const upgradeResult = handleUpgrade(req, server);
      if (upgradeResult === undefined) {
        // Upgrade successful
        return undefined as any;
      }
      // Return error response
      return upgradeResult;
    }

    // For all other HTTP requests, delegate to Express
    // Read body upfront if present
    let bodyBuffer: Buffer | null = null;
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      try {
        const arrayBuffer = await req.arrayBuffer();
        bodyBuffer = Buffer.from(arrayBuffer);
      } catch {
        // Body already consumed or not present
        bodyBuffer = null;
      }
    }

    return new Promise<Response>((resolve) => {
      // Get client IP
      const clientIP = server.requestIP(req)?.address || "127.0.0.1";

      // Create Node.js-compatible request and response objects
      const nodeReq = createNodeRequest(req, url, bodyBuffer, clientIP);
      const nodeRes = createNodeResponse(resolve);

      // Let Express handle the request
      expressApp(nodeReq, nodeRes);
    });
  },
});

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
    ☁️☁️☁️      ⚡ Bun Native WebSocket Enabled ⚡
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️
    ☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️☁️\n`);

export default server;
