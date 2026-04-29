/**
 * mentra dev — Development server
 *
 * Responsibilities (in order):
 *   1. Load mentra.config.ts
 *   2. Ensure bunfig.toml pins React (dedupe plugin)
 *   3. Validate client/ imports (no Node/RN built-ins)
 *   4. Pick a runtime adapter automatically:
 *        - API key present → cloud adapter + MiniAppServer
 *        - otherwise       → sim adapter (in-process simulated glasses)
 *        - mentra.config.ts can override with `runtime: "cloud" | "sim"`
 *   5. If server/index.ts exists, load it as a Hono app and mount it
 *   6. Serve webview/ + /__mentra/state with Bun fullstack (HMR, dedupe plugin)
 *   7. Dynamic-import client/index.ts (the on-device developer code)
 *   8. Print QR + URLs
 *
 * The framework never asks the developer "which mode?" — it picks
 * based on what's available. Explicit override is via config, not env.
 */

import { join } from "path";
import { existsSync } from "fs";
import { networkInterfaces } from "os";
import QRCode from "qrcode-terminal";
import { MiniAppServer } from "./runtime/internals";
import type { MentraSession } from "./runtime/internals";
import { StateManager } from "./runtime/state-manager";
import { loadProject, ensureBunfig, rel } from "./project";
import { pickRuntime } from "./runtime/pick-runtime";
import { CloudAdapter } from "./runtime/adapters/cloud-adapter";
import { SimAdapter } from "./runtime/adapters/sim-adapter";
import { __flushLazyHandlers } from "./runtime/index";
import { __flushServerHandlers } from "./runtime/server";
import type { MentraRuntime } from "./runtime/contract";

const PROJECT_ROOT = process.cwd();
const PORT = parseInt(process.env.PORT || "4242");

// ─── Load project layout ─────────────────────────────────────────────────────

const project = await loadProject(PROJECT_ROOT);
if (!project) {
  console.error("  ❌ No mentra.config.ts found in the current directory.\n");
  console.error("  Run this command from your project root, or run `mentra init` to create a new project.\n");
  process.exit(1);
}

const { config } = project;

// ─── Ensure bunfig.toml with the dedupe plugin ───────────────────────────────

{
  const { written, path } = ensureBunfig(PROJECT_ROOT);
  if (written) {
    console.log(`  📝 Wrote ${rel(PROJECT_ROOT, path)} (React dedupe plugin)`);
    console.log("  \x1b[2m   Restart `mentra dev` for the plugin to take effect.\x1b[0m\n");
  }
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

const BANNED_PATTERNS = [/^react-native$/, /^react-native\//, /^expo-/, /^@react-native/];

/**
 * Cross-folder import rules. `client/` and `server/` code run in different
 * runtimes — mixing their MentraOS imports produces subtle lifecycle bugs
 * (singleton session in a multi-tenant server, per-user handlers on a
 * single-user phone). Catch the obvious mistakes at dev-server start.
 *
 * Exempts:
 *   - `@mentra/js/runtime` — the full forked-SDK surface, fine anywhere
 *   - `@mentra/js/dedupe-plugin` — bundler-side, never executes in either
 */
interface FolderRules {
  /** What shouldn't be imported from this folder. */
  bannedModules: Set<string>;
  /** Regex patterns that shouldn't be imported. */
  bannedPatterns: RegExp[];
  /** Human-readable hint shown when a banned import is found. */
  hint: (importName: string) => string;
}

const CLIENT_RULES: FolderRules = {
  bannedModules: new Set([
    ...BANNED_MODULES,
    // Cross-folder: `@mentra/js/server` is for multi-tenant cloud code
    // and doesn't make sense on the phone.
    "@mentra/js/server",
  ]),
  bannedPatterns: BANNED_PATTERNS,
  hint: (imp) => {
    if (imp === "@mentra/js/server") {
      return `Move this to server/index.ts, or use "session" from "@mentra/js" for phone-side code.`;
    }
    return `Move this code to server/ if you need Node APIs.`;
  },
};

const SERVER_RULES: FolderRules = {
  bannedModules: new Set([
    // Cross-folder: the phone-side `session` proxy doesn't work in a
    // multi-tenant cloud process. Use `onSession` from `@mentra/js/server`.
    "@mentra/js",
  ]),
  bannedPatterns: [
    // react-native and expo have no business on a server
    /^react-native$/,
    /^react-native\//,
    /^expo-/,
    /^@react-native/,
  ],
  hint: (imp) => {
    if (imp === "@mentra/js") {
      return `In server/, use \`onSession\` from "@mentra/js/server" (per-user) instead of \`session\` (singleton).`;
    }
    return `This import looks wrong for server/ code.`;
  },
};

async function validateImports(folder: string, rules: FolderRules): Promise<boolean> {
  const dir = join(PROJECT_ROOT, folder);
  if (!existsSync(dir)) return true;

  const { readdir, readFile } = await import("fs/promises");
  const files = (await readdir(dir, { recursive: true })).filter((f: string) => /\.(ts|tsx|js|jsx)$/.test(f));

  let ok = true;
  for (const file of files) {
    if (file.endsWith(".disabled")) continue;
    const content = await readFile(join(dir, file), "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/(?:import\s+.*from\s+['"]([^'"]+)['"]|require\s*\(['"]([^'"]+)['"]\))/);
      if (!match) continue;
      const imp = match[1] || match[2];
      const banned = rules.bannedModules.has(imp) || rules.bannedPatterns.some((p) => p.test(imp));
      if (banned) {
        if (ok) console.error(`\n  ❌ Invalid imports in ${folder}/:\n`);
        ok = false;
        console.error(`    ${folder}/${file}:${i + 1} — "${imp}" is not allowed here.`);
        console.error(`    ${rules.hint(imp)}\n`);
      }
    }
  }
  return ok;
}

// Validate client/ and server/ up front so mistakes surface at boot,
// not as mysterious runtime behavior later.
{
  const clientOk = await validateImports("client", CLIENT_RULES);
  const serverOk = await validateImports("server", SERVER_RULES);
  if (!clientOk || !serverOk) process.exit(1);
  if (existsSync(join(PROJECT_ROOT, "client"))) {
    console.log("  ✅ client/ imports validated");
  }
  if (existsSync(join(PROJECT_ROOT, "server"))) {
    console.log("  ✅ server/ imports validated");
  }
}

// ─── Shared state manager ────────────────────────────────────────────────────

const stateManager = new StateManager();
globalThis.__mentraState = stateManager;

// ─── Pick a runtime ──────────────────────────────────────────────────────────

const API_KEY = process.env.MENTRAOS_API_KEY || "";

let picked;
try {
  picked = await pickRuntime({
    preference: config.runtime,
    hasApiKey: API_KEY.length > 0,
  });
} catch (err) {
  console.error("  ❌ Couldn't pick a runtime:\n");
  console.error((err as Error).message);
  process.exit(1);
}

const runtime: MentraRuntime = picked.runtime;
globalThis.__mentraRuntime = runtime;
console.log(`  🧠 Runtime: ${runtime.name} \x1b[2m(${picked.reason})\x1b[0m`);

// Expose the sim adapter for the /__mentra/inject endpoint.
if (runtime instanceof SimAdapter) {
  (globalThis as any).__mentraSimAdapter = runtime;
}

// Drain any handlers the developer registered before the runtime was
// installed. See runtime/index.ts `__flushLazyHandlers`.
__flushLazyHandlers();

// ─── Install server-runtime handler registry ─────────────────────────────────
//
// server/ code registers handlers via `import { onSession } from "@mentra/js/server"`.
// Those handlers accumulate in a lazy queue until we install the registry
// (see runtime/server.ts). We install an empty registry now and wire real
// forwarding after MiniAppServer boots.

type SessionHandler = (session: MentraSession) => void | Promise<void>;
type StopHandler = (session: MentraSession | null, reason: string) => void | Promise<void>;
type ToolCallHandler = (toolCall: any) => Promise<any>;

const serverSessionHandlers: SessionHandler[] = [];
const serverStopHandlers: StopHandler[] = [];
const serverToolCallHandlers: ToolCallHandler[] = [];

globalThis.__mentraServerRuntime = {
  onSession: (cb) => {
    serverSessionHandlers.push(cb);
  },
  onStop: (cb) => {
    serverStopHandlers.push(cb);
  },
  onToolCall: (cb) => {
    serverToolCallHandlers.push(cb);
  },
};

// Drain anything server/ code registered before this runtime installed.
// (In practice nothing has loaded yet — server/ is imported further down —
// but the flush is cheap and idempotent.)
__flushServerHandlers();

// ─── Optional user server/ (Hono app + per-session handlers) ─────────────────
//
// Load server/index.ts BEFORE we boot MiniAppServer, so any onSession/onStop
// handlers it registers are in the queue by the time sessions start firing.

type HonoLike = { fetch: (req: Request) => Response | Promise<Response>; route?: any };
let userServer: HonoLike | null = null;
const userServerEntry = project.serverEntry;

if (userServerEntry) {
  try {
    const mod = await import(userServerEntry);
    const exported = mod.default ?? mod.app ?? mod.server;
    if (exported && typeof exported.fetch === "function") {
      userServer = exported as HonoLike;
      console.log(`  🛠  server/ mounted (${rel(PROJECT_ROOT, userServerEntry)})`);
    } else {
      console.warn(`  ⚠️  server/ loaded but no default export with .fetch() found — skipping.`);
      console.warn(`  \x1b[2m   Tip: \`export default new Hono()...\` from server/index.ts.\x1b[0m`);
    }
    // Flush again in case server/index.ts registered handlers via module-load.
    __flushServerHandlers();
  } catch (err) {
    console.error("  ❌ Failed to load server/:\n");
    console.error(err);
  }
}

// ─── Boot MiniAppServer (cloud adapter only) ─────────────────────────────────
//
// Fans session events out to:
//   1. The cloud adapter (so client/ code binds to the current session)
//   2. Every handler registered via `onSession()` in server/ code
// Handler #2 is how multi-tenant server/ apps (like flash) receive per-user
// sessions. Handler #1 is for the single-session client/-dev flow.

let miniAppServerRunning = false;
let miniAppServer: MiniAppServer | null = null;

if (picked.needsMiniAppServer && runtime instanceof CloudAdapter) {
  try {
    const app = new MiniAppServer({
      packageName: config.packageName,
      apiKey: API_KEY,
      port: PORT,
    });
    miniAppServer = app;

    app.onSession(async (session: MentraSession) => {
      session.logger.info(`[mentra dev] Session started for ${session.userId}`);
      globalThis.__mentraSession = session;
      runtime.bind(session);

      // Fan out to server/ handlers. Run them concurrently; swallow errors
      // per-handler so one misbehaving developer handler doesn't break the
      // session for others.
      for (const h of serverSessionHandlers) {
        try {
          await h(session);
        } catch (err) {
          session.logger.error({ err }, "[mentra dev] onSession handler threw");
        }
      }
    });

    app.onStop(async (session, reason) => {
      if (session) {
        session.logger.info(`[mentra dev] Session stopped: ${reason}`);
      }
      runtime.unbind(reason);
      globalThis.__mentraSession = undefined;

      for (const h of serverStopHandlers) {
        try {
          await h(session, reason);
        } catch (err) {
          console.error("[mentra dev] onStop handler threw:", err);
        }
      }
    });

    // Mount user's server/ Hono app inside MiniAppServer so it shares
    // auth middleware, session context, and routing with the SDK.
    // Matches legacy flash's `app.route("/api", api)` pattern.
    if (userServer) {
      try {
        // MiniAppServer extends Hono — `app.route(prefix, subApp)` is Hono.
        // We mount at root so user's server/index.ts decides its own paths
        // (typically `/api/*` via `app.route("/api", api)` inside server/).
        (app as any).route("/", userServer);
      } catch (err) {
        console.warn(`  ⚠️  Failed to mount server/ inside MiniAppServer:`, err);
      }
    }

    if (serverToolCallHandlers.length > 0) {
      app.onToolCall(async (toolCall: any) => {
        // Run all handlers; take the first non-undefined result.
        for (const h of serverToolCallHandlers) {
          try {
            const result = await h(toolCall);
            if (result !== undefined) return result;
          } catch (err) {
            console.error("[mentra dev] onToolCall handler threw:", err);
          }
        }
        return undefined;
      });
    }

    await app.start();
    miniAppServerRunning = true;
    // No port log — MiniAppServer doesn't bind a port. The Bun.serve
    // below uses `miniAppServer.fetch` as a fallback so /webhook,
    // /photo-upload, /tool, and the user's server/ Hono routes all
    // share the single PORT.
  } catch (err) {
    console.warn(`  ⚠️  MiniAppServer failed to start: ${err}`);
    console.warn("  Continuing with webview-only (cloud adapter idle).\n");
  }
}

// ─── Serve webview with Bun fullstack ────────────────────────────────────────

const webviewHtmlPath = project.webviewHtml;
let webviewHtml: any = null;

if (webviewHtmlPath && existsSync(webviewHtmlPath)) {
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

// SSE stream + state write handler. Co-located at /__mentra/state:
//   - GET  → subscribe via Server-Sent Events (snapshot + updates)
//   - POST → set a key/value pair (used by webviews writing back state)
//   - OPTIONS → CORS preflight
const stateRoute = {
  GET(_req: Request): Response {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const snapshot = JSON.stringify(stateManager.getAll());
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${snapshot}\n\n`));
        const unsub = stateManager.onChange(() => {
          try {
            const update = JSON.stringify(stateManager.getAll());
            controller.enqueue(encoder.encode(`event: update\ndata: ${update}\n\n`));
          } catch {
            unsub();
          }
        });
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
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },

  async POST(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as any;
    if (body?.key && body?.value !== undefined) {
      stateManager.set(body.key, body.value);
    }
    return Response.json({ ok: true }, { headers: { "Access-Control-Allow-Origin": "*" } });
  },

  OPTIONS(): Response {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  },
};

// ─── Framework routes (explicit, most-specific first) ───────────────────────
// Each entry is either a Response, a single-arg handler, or a method-handler
// object. Bun's router matches most-specific first, then falls through to the
// wildcard that forwards into MiniAppServer.

const stateJsonRoute = () =>
  Response.json(stateManager.getAll(), {
    headers: { "Access-Control-Allow-Origin": "*" },
  });

const runtimeInfoRoute = () =>
  Response.json(
    {
      adapter: runtime.name,
      reason: picked.reason,
      miniAppServerRunning,
      configRuntime: config.runtime ?? "auto",
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );

const injectTranscriptionRoute = {
  async POST(req: Request): Promise<Response> {
    const sim = (globalThis as any).__mentraSimAdapter as SimAdapter | undefined;
    if (!sim) {
      return Response.json({ ok: false, error: "inject/* is only available on the sim adapter" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as any;
    sim.injectTranscription({
      text: String(body.text ?? ""),
      isFinal: body.isFinal !== false,
      language: body.language,
    });
    return Response.json({ ok: true });
  },
};

// Catch-all: forward anything not matched above into MiniAppServer. This is
// how /webhook, /photo-upload, /tool, /health, /mentra-auth, and user-mounted
// /api/* routes from server/index.ts reach the SDK. If we have no cloud
// adapter (sim mode), MiniAppServer isn't booted, so we return 404.
const catchAllRoute = (req: Request): Response | Promise<Response> => {
  if (miniAppServer) return miniAppServer.fetch(req);
  return new Response("Not found", { status: 404 });
};

Bun.serve({
  port: PORT,
  routes: {
    // Webview entrypoints — HTMLRewriter + bundling + HMR.
    ...(webviewHtml ? { "/": webviewHtml, "/app/*": webviewHtml } : {}),

    // Framework endpoints. All under /__mentra/* to avoid colliding with
    // user's /api/* routes.
    "/__mentra/state": stateRoute, // GET SSE, POST set, OPTIONS CORS
    "/__mentra/state.json": stateJsonRoute, // GET → snapshot
    "/__mentra/runtime": runtimeInfoRoute, // GET → adapter info
    "/__mentra/inject/transcription": injectTranscriptionRoute, // POST (sim only)

    // Everything else → MiniAppServer (or 404 if no cloud adapter).
    "/*": catchAllRoute,
  } as any,
  development: {
    hmr: true,
    console: true,
  },
});

// ─── Load client/ code ───────────────────────────────────────────────────────

if (project.clientEntry) {
  try {
    await import(project.clientEntry);
    console.log(`  ✅ ${rel(PROJECT_ROOT, project.clientEntry)} loaded\n`);
  } catch (err) {
    console.error(`  ❌ Error loading ${rel(PROJECT_ROOT, project.clientEntry)}:\n`);
    console.error(err);
    console.error("");
  }
} else {
  console.log("  ⚠️  No client/index.ts found — create one to add glasses logic.\n");
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
  "  \x1b[2mServing:\x1b[0m webview/ + client/" + (userServer ? " + server/" : "") + " \x1b[2m(HMR enabled)\x1b[0m",
);
console.log(`  \x1b[2mRuntime:\x1b[0m ${runtime.name} — ${picked.reason}`);
console.log("  \x1b[2mPress Ctrl+C to stop.\x1b[0m");
console.log("");
