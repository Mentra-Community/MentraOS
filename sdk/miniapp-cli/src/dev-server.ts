// Sidecar dev server for `mentra-miniapp dev`. Runs on `userPort + 1`,
// alongside the static file server `dev.ts` boots on `userPort`. Hosts
// the `__mentra_dev` WebSocket multiplexed channel:
//
//   laptop → phone : {type: "reload"}                 (UI WebView reload — filesystem watcher fired in src/ui)
//   laptop → phone : {type: "respawn-bg"}              (background JSContext respawn — filesystem watcher fired in src/background)
//   phone  → laptop: {type: "log", level, args, ...}  (forwarded console calls)
//
// Plus a hello handshake (`{type: "hello", protocol: "mentra-dev/1"}` →
// `{type: "hello-ack"}`) so a phone connecting to the wrong sidecar (or an
// older one) can detect mismatch.
//
// Also exposes `/__mentra_dev/bundle.zip` — a flat snapshot of the
// project (including `dist/`) the phone-side install pipeline downloads
// and unpacks into `lmas/<pkg>/dev-<ts>/`. `onBeforeBroadcast` is the
// hook that rebuilds `dist/` before each broadcast so the next zip
// fetch ships current code.

import {readdirSync, readFileSync, statSync, watch} from "fs"
import {join, relative} from "path"
import JSZip from "jszip"
import type {ServerWebSocket} from "bun"

export interface DevServerOptions {
  port: number
  /** Project root to watch for filesystem changes. Triggers reload broadcasts. */
  watchDir: string
  /** Suppress info console.log output. Default false. */
  silent?: boolean
  /**
   * Hook run inside the debounced broadcast window, after the filesystem
   * settles but before the phone is notified. Two-layer projects use this
   * to rebuild the `dist/` snapshot so the next `bundle.zip` fetch ships
   * fresh code. Rejection is caught + logged; the broadcast still fires.
   */
  onBeforeBroadcast?: (type: "reload" | "respawn-bg") => Promise<void>
}

interface ClientWsData {
  packageName: string | null
  remoteAddress: string
}

const PROTOCOL_VERSION = "mentra-dev/1"
const RELOAD_DEBOUNCE_MS = 100

/** Inbound message from the phone. */
type Inbound =
  | {type: "hello"; protocol: string}
  | {
      type: "log"
      level: string
      args: unknown[]
      packageName: string
      timestamp: number
      /**
       * Which half of the miniapp emitted the log. UI = WebView, background
       * = JSContext. Lets us prefix lines so devs can tell the always-on
       * glasses logic apart from the WebView UI when both are noisy.
       */
      source: "ui" | "background"
    }

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
}

function colorForLevel(level: string): string {
  switch (level) {
    case "error":
      return COLOR.red
    case "warn":
      return COLOR.yellow
    case "info":
    case "debug":
      return COLOR.dim
    default:
      return COLOR.cyan
  }
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a !== null && typeof a === "object" && (a as Record<string, unknown>).__error === true) {
        const err = a as {message?: string; stack?: string}
        return err.stack || err.message || String(a)
      }
      if (typeof a === "string") return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(" ")
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

/**
 * Start the sidecar. Returns a handle with `stop()` so dev.ts can clean up on
 * SIGINT.
 */
export function startDevSidecar(options: DevServerOptions): {stop: () => void; port: number} {
  const sockets = new Set<ServerWebSocket<ClientWsData>>()
  const log = options.silent ? () => {} : (...args: unknown[]) => console.log(...args)

  const server = Bun.serve<ClientWsData>({
    hostname: "0.0.0.0",
    port: options.port,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/__mentra_dev/health") {
        return new Response(JSON.stringify({ok: true, protocol: PROTOCOL_VERSION}), {
          headers: {"content-type": "application/json"},
        })
      }
      if (url.pathname === "/__mentra_dev/bundle.zip") {
        // Snapshot of the project files for the phone-side bundle cache.
        // Phone calls Composer.installMiniApp(this URL) to download + unzip
        // into lmas/<pkg>/dev-<timestamp>/ — same path store-installed
        // miniapps take, just with a dev-prefixed version directory.
        //
        // Files are placed at the zip root (no enclosing folder). The
        // unpacker on the phone side requires miniapp.json to be at the
        // top level. Flat structure makes that contract clean.
        return buildProjectZip(options.watchDir).then((buf) => {
          // `bun-types` typed Response body as ArrayBuffer / Blob / etc.
          // — but NOT a raw Uint8Array view. Pass the underlying buffer
          // slice instead so the response stream gets the exact bytes.
          const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
          return new Response(body, {
            headers: {
              "content-type": "application/zip",
              "content-length": String(buf.byteLength),
            },
          })
        })
      }
      if (url.pathname === "/__mentra_dev") {
        const upgraded = srv.upgrade(req, {
          data: {packageName: null, remoteAddress: srv.requestIP(req)?.address ?? "unknown"},
        })
        if (upgraded) return undefined
        return new Response("WebSocket upgrade required", {status: 400})
      }
      return new Response("Not found", {status: 404})
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        // Quiet on connect — the `reload` line tells the dev their
        // device is plugged into the sidecar. Otherwise normal HMR
        // cycles (which respawn the JSContext + WebView) spam
        // connected/disconnected pairs per filesystem change.
      },
      message(ws, message) {
        let parsed: Inbound
        try {
          parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as Inbound
        } catch {
          return
        }
        switch (parsed.type) {
          case "hello": {
            // Echo back so the phone confirms the right server.
            ws.send(JSON.stringify({type: "hello-ack", protocol: PROTOCOL_VERSION}))
            return
          }
          case "log": {
            const color = colorForLevel(parsed.level)
            // Source-prefix lets devs tell UI ↔ background apart at a
            // glance. UI cyan, MentraJS magenta.
            const sourceTag =
              parsed.source === "ui"
                ? `${COLOR.cyan}[UI]${COLOR.reset}`
                : `${COLOR.magenta}[MentraJS]${COLOR.reset}`
            const tag = `${color}${parsed.level}${COLOR.reset}`
            const body = formatLogArgs(parsed.args ?? [])
            log(
              `${COLOR.dim}${fmtTime(parsed.timestamp ?? Date.now())}${COLOR.reset} ${sourceTag} ${tag} ${body}`,
            )
            return
          }
        }
      },
      close(ws) {
        sockets.delete(ws)
        // Quiet on disconnect — see open(); steady-state HMR cycles
        // through this constantly and there's nothing the dev does
        // with the signal.
      },
    },
  })

  // Filesystem watcher → broadcast reload or respawn-bg depending on which
  // layer changed. Background code lives under `src/background/` and UI
  // code under `src/ui/`; a touch under `src/background/` requires killing
  // + re-spawning the JSContext, while a touch under `src/ui/` only needs
  // a WebView reload. Touches anywhere else default to reload.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let pendingType: "reload" | "respawn-bg" | null = null
  let suppressEventsUntil = 0
  // True when a path either equals `name` or sits under `name/`. macOS
  // FSEvents under `recursive: true` emits the bare directory name when
  // the directory itself is rm-rf'd or renamed; matching only `name/`
  // would let that event through and cause a rebuild loop.
  const isUnder = (filename: string, name: string): boolean =>
    filename === name || filename.startsWith(`${name}/`) || filename.includes(`/${name}/`)

  const watcher = watch(options.watchDir, {recursive: true}, (_event, filename) => {
    if (!filename) return
    if (Date.now() < suppressEventsUntil) return
    // macOS recursive FSEvents can report "." when the build removes and
    // recreates dist/. Treat that as build-output churn; otherwise the dev
    // server rebuilds in a tight loop.
    if (filename === ".") return
    // Skip noisy directories — most projects don't want to reload on
    // node_modules or dist churn (the rebuild itself rewrites dist/,
    // which would otherwise loop).
    if (isUnder(filename, "node_modules")) return
    if (isUnder(filename, ".git")) return
    if (isUnder(filename, "dist")) return
    if (isUnder(filename, "build")) return // pack/release zip output
    if (isUnder(filename, ".next")) return

    // Decide which layer the change touched. Order matters: a single batch
    // may hit both layers; if so, respawn-bg wins (it implies a full reload
    // anyway on the WebView side because background drives the UI state).
    const touchedBackground =
      filename.startsWith("src/background/") || filename.includes("/src/background/")
    const nextType: "reload" | "respawn-bg" = touchedBackground ? "respawn-bg" : "reload"
    if (pendingType === "respawn-bg") {
      // already locked in to the heavier signal — leave it
    } else {
      pendingType = nextType
    }

    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      reloadTimer = null
      const type = pendingType ?? "reload"
      pendingType = null
      // Two-layer projects rebuild `dist/` here so the next bundle.zip
      // fetch ships current code. A build failure surfaces in the
      // terminal but does not block the broadcast — phones will install
      // whatever the previous successful build left behind.
      if (options.onBeforeBroadcast) {
        try {
          suppressEventsUntil = Date.now() + 1_500
          await options.onBeforeBroadcast(type)
          suppressEventsUntil = Date.now() + 1_500
        } catch (err) {
          suppressEventsUntil = Date.now() + 1_500
          log(`${COLOR.red}[__mentra_dev] onBeforeBroadcast failed:${COLOR.reset} ${(err as Error).message}`)
        }
      }
      const msg = JSON.stringify({type})
      let count = 0
      for (const s of sockets) {
        try {
          s.send(msg)
          count++
        } catch {
          /* ignore */
        }
      }
      if (count > 0) {
        // Concise reload line — match React Native Metro's style.
        // `reload` covers the common case; `respawn-bg` is rarer so
        // we tag it explicitly so the dev knows the JSContext is
        // restarting (which clears in-memory state in the
        // controller).
        const verb = type === "respawn-bg" ? "respawn-bg" : "reload"
        log(`${COLOR.cyan}${verb}${COLOR.reset} ${COLOR.dim}${filename}${COLOR.reset}`)
      }
    }, RELOAD_DEBOUNCE_MS)
  })

  log(`${COLOR.dim}[__mentra_dev]${COLOR.reset} sidecar listening on :${options.port}`)

  return {
    port: options.port,
    stop() {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      if (reloadTimer) clearTimeout(reloadTimer)
      for (const s of sockets) {
        try {
          s.close()
        } catch {
          /* ignore */
        }
      }
      sockets.clear()
      server.stop(true)
    },
  }
}

/**
 * One file to include in the bundle zip.
 *   - `disk`  : path on disk, relative to the project root (used to read it).
 *   - `entry` : zip-internal name (used to store it in the zip).
 *
 * These diverge for build output: it lives under `dist/` on disk but ships at
 * the bundle root (`dist/` stripped), so the zip layout matches `entry.*` in
 * miniapp.json — which the host resolves relative to the bundle root.
 */
export interface ProjectFile {
  disk: string
  entry: string
}

/**
 * Walk the dev project's directory tree and return the files to include in
 * the bundle zip, as {disk, entry} pairs.
 *
 * STRICT runtime-artifact allowlist:
 *   - miniapp.json at the root (required — unpacker fails without it)
 *   - icon.png (or whatever `manifest.icon` points at) — used for the
 *     home tile and the QR-scan icon preview
 *   - dist/ — the entire two-layer build output: dist/background/*.js
 *     and dist/ui/* (HTML, JS chunks, CSS chunks). Recursively included.
 *     The `dist/` prefix is stripped off the zip entry name (see ProjectFile),
 *     so `dist/background/index.js` ships as `background/index.js`.
 *
 * Source files (src/), build config (package.json, tsconfig.json,
 * build.ts, bunfig.toml), node_modules/, public/, and stray pack
 * artifacts (*.zip) are deliberately NOT shipped. They aren't read by
 * the runtime and including them adds tens-to-hundreds of KB per
 * install — slow on flaky LAN, painful for a "hot reload" loop.
 *
 * Entry names have no leading slash — the phone-side unpacker
 * (Composer.installMiniApp) needs them exactly that way to reconstruct the
 * directory tree on disk.
 */
export function listProjectFiles(rootDir: string): ProjectFile[] {
  const out: ProjectFile[] = []

  // miniapp.json (required at zip root).
  const manifestPath = join(rootDir, "miniapp.json")
  let manifest: Record<string, unknown> | null = null
  try {
    if (statSync(manifestPath).isFile()) {
      out.push({disk: "miniapp.json", entry: "miniapp.json"})
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>
    }
  } catch {
    /* no manifest yet — the dev server will refuse to start; not our
       problem here. */
  }

  // Icon (whatever path the manifest declares; default `icon.png`).
  const iconRel = typeof manifest?.icon === "string" ? manifest.icon : "icon.png"
  try {
    if (statSync(join(rootDir, iconRel)).isFile()) {
      const rel = iconRel.replace(/^\//, "")
      out.push({disk: rel, entry: rel})
    }
  } catch {
    /* no icon — non-fatal, the home tile will just render the fallback. */
  }

  // dist/ — full recursive walk. `onBeforeBroadcast` in `dev.ts` runs
  // a fresh build before each broadcast, so what we read here is
  // current at zip time. MAX_FILES guards against pathological cases
  // (e.g. someone copying public/ into dist/).
  const distRoot = join(rootDir, "dist")
  const MAX_FILES = 500
  const MAX_DEPTH = 10
  type Frame = {dir: string; depth: number}
  const queue: Frame[] = []
  try {
    if (statSync(distRoot).isDirectory()) queue.push({dir: distRoot, depth: 0})
  } catch {
    /* no dist yet — initial build failed or hasn't run; ship the
       manifest + icon and let the host log "missing entry path". */
  }
  while (queue.length > 0 && out.length < MAX_FILES) {
    const {dir, depth} = queue.shift()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue
      const abs = join(dir, entry)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) queue.push({dir: abs, depth: depth + 1})
      } else if (stat.isFile()) {
        const disk = relative(rootDir, abs).split("\\").join("/")
        // Strip the leading `dist/` so build output ships at the bundle root.
        const entryName = disk.replace(/^dist\//, "")
        out.push({disk, entry: entryName})
        if (out.length >= MAX_FILES) {
          console.warn(
            `[__mentra_dev] dist file list truncated at ${MAX_FILES} entries — bundle may be incomplete`,
          )
          return out
        }
      }
    }
  }

  return out
}

/**
 * Build a flat ZIP of the project files (files at zip root, no enclosing
 * folder). Returns the encoded buffer.
 *
 * The phone-side unpacker (Composer.installMiniApp) requires miniapp.json
 * to be at the zip's top level. Flat structure keeps the contract clean
 * — the unpacker can fail loudly if the zip is malformed instead of
 * tolerating multiple shapes.
 */
export async function buildProjectZip(rootDir: string): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const {disk, entry} of listProjectFiles(rootDir)) {
    const abs = join(rootDir, disk)
    try {
      const buf = readFileSync(abs)
      zip.file(entry, buf)
    } catch (err) {
      console.warn(`[__mentra_dev] failed to read ${disk}, skipping:`, err)
    }
  }
  // STORE (no compression) — small project trees, deterministic, fast.
  return zip.generateAsync({type: "uint8array", compression: "STORE"})
}
