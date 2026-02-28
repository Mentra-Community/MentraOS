/**
 * @fileoverview Legacy Express handler for unmigrated routes.
 * This module provides a compatibility layer to handle Express routes that haven't
 * been migrated to Hono yet. It uses the same request/response bridge as the
 * original index.ts but only for the legacy routes.
 *
 * This should be removed once all routes are migrated to Hono.
 */

import { Readable } from "stream";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { CORS_ORIGINS } from "./config/cors";
import { logger as rootLogger } from "./services/logging/pino-logger";

// Legacy route modules (to be migrated to Hono)
import appRoutes from "./routes/apps.routes";
import authRoutes from "./routes/auth.routes";
import transcriptRoutes from "./routes/transcripts.routes";
import appSettingsRoutes from "./routes/app-settings.routes";
import errorReportRoutes from "./routes/error-report.routes";
import devRoutes from "./routes/developer.routes";
import adminRoutes from "./routes/admin.routes";
import photoRoutes from "./routes/photos.routes";
import galleryRoutes from "./routes/gallery.routes";
import toolsRoutes from "./routes/tools.routes";
import hardwareRoutes from "./routes/hardware.routes";
import audioRoutes from "./routes/audio.routes";

import permissionsRoutes from "./routes/permissions.routes";
import accountRoutes from "./routes/account.routes";
import organizationRoutes from "./routes/organization.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import appUptimeRoutes from "./routes/app-uptime.routes";
import streamsRoutes from "./routes/streams.routes";

// Console APIs (still Express - to be migrated)
import consoleAccountApi from "./api/console/console.account.api";
import orgsApi from "./api/console/orgs.api";
import consoleAppsApi from "./api/console/console.apps.api";
import cliKeysApi from "./api/console/cli-keys.api";

// Legacy middleware
import { authenticateCLI } from "./api/middleware/cli.middleware";
import { authenticateConsole } from "./api/middleware/console.middleware";

const logger = rootLogger.child({ service: "legacy-express" });
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 80;

/**
 * Create the legacy Express app with all unmigrated routes.
 */
function createExpressApp() {
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
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        }),
      },
      autoLogging: {
        ignore: (req) => {
          return req.url === "/health" || req.url?.startsWith("/api/livekit/token");
        },
      },
    }),
  );

  // Transform middleware: req.cli → req.console (handlers expect req.console)
  const transformCLIToConsole = (req: any, _res: any, next: any) => {
    if (req.cli) {
      req.console = { email: req.cli.email };
    }
    next();
  };

  // Console mounts (with console auth middleware)
  expressApp.use("/api/console/account", authenticateConsole, consoleAccountApi);
  expressApp.use("/api/console/orgs", authenticateConsole, orgsApi);
  expressApp.use("/api/console/apps", authenticateConsole, consoleAppsApi);
  expressApp.use("/api/console/cli-keys", authenticateConsole, cliKeysApi);

  // CLI mounts - reuse console routes with CLI auth + transform
  expressApp.use("/api/cli/apps", authenticateCLI, transformCLIToConsole, consoleAppsApi);
  expressApp.use("/api/cli/orgs", authenticateCLI, transformCLIToConsole, orgsApi);

  // Legacy mounts (to be migrated)
  expressApp.use("/api/apps", appRoutes);
  expressApp.use("/api/auth", authRoutes);
  expressApp.use("/apps", appRoutes);
  expressApp.use("/auth", authRoutes);
  expressApp.use("/appsettings", appSettingsRoutes);
  expressApp.use("/tpasettings", appSettingsRoutes);
  expressApp.use("/api/dev", devRoutes);
  expressApp.use("/api/admin", adminRoutes);
  expressApp.use("/api/orgs", organizationRoutes);

  expressApp.use("/api/photos", photoRoutes);
  expressApp.use("/api/gallery", galleryRoutes);
  expressApp.use("/api/tools", toolsRoutes);
  expressApp.use("/api/permissions", permissionsRoutes);
  expressApp.use("/api/hardware", hardwareRoutes);

  expressApp.use(errorReportRoutes);
  expressApp.use(transcriptRoutes);
  expressApp.use(audioRoutes);

  expressApp.use("/api/account", accountRoutes);
  expressApp.use("/api/onboarding", onboardingRoutes);
  expressApp.use("/api/app-uptime", appUptimeRoutes);
  expressApp.use("/api/streams", streamsRoutes);

  return expressApp;
}

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
      this.push(null);
    },
  });

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

    on: () => nodeRes,
    once: () => nodeRes,
    off: () => nodeRes,
    emit: () => false,
    removeListener: () => nodeRes,
    addListener: () => nodeRes,
  };

  return nodeRes;
}

/**
 * Create a handler function that bridges Bun requests to Express.
 * Returns a function that can be called from Bun.serve fetch handler.
 */
export function createLegacyExpressHandler() {
  const expressApp = createExpressApp();

  return async function handleRequest(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url);

    // Read body upfront if present
    let bodyBuffer: Buffer | null = null;
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      try {
        const arrayBuffer = await req.arrayBuffer();
        bodyBuffer = Buffer.from(arrayBuffer);
      } catch {
        bodyBuffer = null;
      }
    }

    return new Promise<Response>((resolve) => {
      const clientIP = server.requestIP(req)?.address || "127.0.0.1";
      const nodeReq = createNodeRequest(req, url, bodyBuffer, clientIP);
      const nodeRes = createNodeResponse(resolve);

      expressApp(nodeReq, nodeRes);
    });
  };
}
