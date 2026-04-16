/**
 * mentra dev — Development server
 *
 * 1. Reads mentra.config.ts from the project root
 * 2. Validates client/ imports (no Node built-ins)
 * 3. Creates a MiniAppServer from @mentra/sdk (v3)
 * 4. Loads client/index.ts and wires session + state
 * 5. Serves webview/ with Bun fullstack (HMR, Tailwind)
 * 6. Shows QR code in terminal
 */

import { join } from "path";
import { existsSync } from "fs";
import { networkInterfaces } from "os";
import QRCode from "qrcode-terminal";
import { MiniAppServer, type MentraSession } from "@mentra/sdk";
import { StateManager } from "./runtime/state-manager";

const PROJECT_ROOT = process.cwd();
const PORT = parseInt(process.env.PORT || "4242");

// ─── Load config ─────────────────────────────────────────────────────────────

interface MentraConfig {
  packageName: string;
  name: string;
  version?: string;
  permissions?: string[];
  server?: { env?: string[] };
}

let config: MentraConfig;
const configPath = join(PROJECT_ROOT, "mentra.config.ts");
if (existsSync(configPath)) {
  const mod = await import(configPath);
  config = mod.default;
} else {
  console.error("  ❌ No mentra.config.ts found in the current directory.\n");
  console.error(
    "  Run this command from your project root, or run `mentra init` to create a new project.\n",
  );
  process.exit(1);
}

// ─── Validate client/ imports ────────────────────────────────────────────────

const BANNED_MODULES = new Set([
  "fs",
  "fs/promises",
  "path",
  "os",
  "crypto",
  "net",
  "http",
  "https",
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "module",
  "stream",
  "tls",
  "url",
  "util",
  "vm",
  "worker_threads",
  "zlib",
  "bun",
  "bun:test",
  "bun:sqlite",
  "bun:ffi",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:os",
  "node:crypto",
  "node:net",
  "node:http",
  "node:https",
  "node:child_process",
  "node:stream",
]);

const BANNED_PATTERNS = [
  /^react-native$/,
  /^react-native\//,
  /^expo-/,
  /^@react-native/,
];

const clientDir = join(PROJECT_ROOT, "client");
if (existsSync(clientDir)) {
  const { readdir, readFile } = await import("fs/promises");
  const files = (await readdir(clientDir, { recursive: true })).filter(
    (f: string) => /\.(ts|tsx|js|jsx)$/.test(f),
  );

  let hasErrors = false;
  for (const file of files) {
    if (file.endsWith(".disabled")) continue;
    const content = await readFile(join(clientDir, file), "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(
        /(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(['"]([^'"]+)['"]\))/,
      );
      if (match) {
        const imp = match[1] || match[2];
        const banned =
          BANNED_MODULES.has(imp) ||
          BANNED_PATTERNS.some((p) => p.test(imp));
        if (banned) {
          if (!hasErrors) console.error("\n  ❌ Invalid imports in client/:\n");
          hasErrors = true;
          console.error(
            `    client/${file}:${i + 1} — "${imp}" is not available in the client runtime.`,
          );
          console.error(
            `    Move this code to server/ if you need Node APIs.\n`,
          );
        }
      }
    }
  }
  if (hasErrors) process.exit(1);
  console.log("  ✅ client/ imports validated\n");
}

// ─── Create MiniAppServer (real SDK v3) ──────────────────────────────────────

const API_KEY = process.env.MENTRAOS_API_KEY || "";

// Create the shared state manager for client ↔ webview sync
const stateManager = new StateManager();

// Make state available globally for the runtime
globalThis.__mentraState = stateManager;

const sdkPort = PORT + 1; // SDK server on a different port; Bun fullstack on PORT

// Only create the real SDK server if we have an API key.
// Without a key, we still serve the webview with HMR — just no cloud connection.
// This lets developers build and preview their UI without needing glasses or cloud.
let sdkRunning = false;

if (API_KEY) {
  try {
    const app = new MiniAppServer({
      packageName: config.packageName,
      apiKey: API_KEY,
      port: sdkPort,
    });

    app.onSession((session: MentraSession) => {
      const userId = session.userId;
      session.logger.info(`[mentra dev] Session started for ${userId}`);

      // Make session and state available to the client code via globals.
      // The runtime/index.ts reads these globals to provide the developer-facing
      // `session` and `state` APIs.
      globalThis.__mentraSession = session;
      globalThis.__mentraState = stateManager;

      // Emit ready so any session.onReady() handlers fire
      stateManager.emit("session_ready", session);
    });

    app.onStop((session, reason) => {
      if (session) {
        session.logger.info(`[mentra dev] Session stopped: ${reason}`);
      }
      stateManager.emit("session_stopped", reason);
      globalThis.__mentraSession = undefined;
    });

    await app.start();
    sdkRunning = true;
    console.log(
      `  📡 SDK server on port ${sdkPort} (webhooks + cloud protocol)`,
    );
  } catch (err) {
    console.warn(`  ⚠️  SDK server failed to start: ${err}`);
    console.warn("  Continuing with webview-only mode.\n");
  }
} else {
  console.log(
    "  📱 No MENTRAOS_API_KEY — webview-only mode (no cloud connection)",
  );
  console.log(
    "  \x1b[2mSet MENTRAOS_API_KEY in .env to enable glasses + cloud features.\x1b[0m\n",
  );
}

// ─── Serve webview with Bun fullstack ────────────────────────────────────────

const webviewHtmlPath = join(PROJECT_ROOT, "webview", "index.html");
let webviewHtml: any = null;

if (existsSync(webviewHtmlPath)) {
  // Dynamic import so Bun processes it as an HTML entrypoint with HMR
  webviewHtml = (await import(webviewHtmlPath)).default;
}

function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

const localIP = getLocalIP();
const networkURL = `http://${localIP}:${PORT}`;

// State sync endpoint — webview subscribes via SSE for real-time state updates
const stateRoute = {
  GET(_req: Request): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Send initial snapshot
        const snapshot = JSON.stringify(stateManager.getAll());
        controller.enqueue(
          encoder.encode(`event: snapshot\ndata: ${snapshot}\n\n`),
        );

        // Subscribe to updates
        const unsub = stateManager.onChange(() => {
          try {
            const update = JSON.stringify(stateManager.getAll());
            controller.enqueue(
              encoder.encode(`event: update\ndata: ${update}\n\n`),
            );
          } catch {
            unsub();
          }
        });

        // Keepalive every 30s
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
            unsub();
          }
        }, 30_000);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

const server = Bun.serve({
  port: PORT,
  routes: {
    ...(webviewHtml
      ? { "/": webviewHtml, "/app/*": webviewHtml }
      : {}),
    "/__mentra/state": stateRoute,
  },
  fetch(req) {
    const url = new URL(req.url);

    // API: get current state snapshot as JSON
    if (url.pathname === "/__mentra/state.json") {
      return Response.json(stateManager.getAll(), {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // API: set state (from client/ code or RPC)
    if (url.pathname === "/__mentra/state" && req.method === "POST") {
      return (async () => {
        const body = await req.json();
        if (body.key && body.value !== undefined) {
          stateManager.set(body.key, body.value);
        }
        return Response.json(
          { ok: true },
          {
            headers: { "Access-Control-Allow-Origin": "*" },
          },
        );
      })();
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
  development: {
    hmr: true,
    console: true,
  },
});

// ─── Load client code ────────────────────────────────────────────────────────

// After the server is running, dynamically load the developer's client/index.ts.
// This file imports from "@mentra/js" which reads the globals we set above.
const clientEntry = join(PROJECT_ROOT, "client", "index.ts");
if (existsSync(clientEntry)) {
  try {
    await import(clientEntry);
    console.log("  ✅ client/index.ts loaded\n");
  } catch (err) {
    console.error("  ❌ Error loading client/index.ts:\n");
    console.error(err);
    console.error("");
  }
} else {
  console.log(
    "  ⚠️  No client/index.ts found — create one to add glasses logic.\n",
  );
}

// ─── QR Code + Banner ────────────────────────────────────────────────────────

function printQR(url: string): Promise<void> {
  return new Promise((resolve) => {
    QRCode.generate(url, { small: true }, (qr: string) => {
      const indented = qr
        .split("\n")
        .map((line: string) => "  " + line)
        .join("\n");
      console.log(indented);
      resolve();
    });
  });
}

console.log("");
console.log("  😎 \x1b[1mMentraOS Dev Server\x1b[0m");
console.log(`  ${config.name} (${config.packageName})`);
console.log("");
console.log(`  Local:   \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
console.log(`  Network: \x1b[36m${networkURL}\x1b[0m`);
console.log("");
await printQR(networkURL);
console.log("");
console.log(
  "  \x1b[2mServing:\x1b[0m webview/ + client/ \x1b[2m(HMR enabled)\x1b[0m",
);
if (sdkRunning) {
  console.log(
    `  \x1b[2mCloud:\x1b[0m SDK on port ${sdkPort}`,
  );
} else {
  console.log(
    "  \x1b[2mCloud:\x1b[0m not connected \x1b[2m(set MENTRAOS_API_KEY for cloud features)\x1b[0m",
  );
}
console.log("  \x1b[2mPress Ctrl+C to stop.\x1b[0m");
console.log("");
