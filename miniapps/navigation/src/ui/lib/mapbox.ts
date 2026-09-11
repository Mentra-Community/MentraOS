/**
 * MapboxManager
 *
 * Mapbox GL JS replacement for the old GoogleMapsManager. Unlike the
 * Google loader (which injected a remote <script>), GL JS is bundled via
 * npm (`mapbox-gl`), so "loading" is just: import the module, set the
 * access token, and import the stylesheet. We keep the same
 * `whenReady(): Promise<void>` / `ready` / `error` / `apiKey` surface so
 * `App.tsx`, `RawMapPage`, and `NavMap` can switch over with minimal
 * changes.
 *
 * Token: build.ts inlines `PUBLIC_MAPBOX_TOKEN` via `define` for release
 * builds; dev fetches `/api/config` (`mapboxToken`) from the local server,
 * mirroring how the Google key was resolved.
 *
 * The CSS (`mapbox-gl/dist/mapbox-gl.css`) is MANDATORY — without it
 * markers/controls/canvas render incorrectly.
 */

import mapboxgl from "mapbox-gl"
import "mapbox-gl/dist/mapbox-gl.css"

export {mapboxgl}

export class MapboxManager {
  private loadPromise: Promise<void>
  private _ready = false
  private _error: string | null = null
  private _apiKey: string = ""

  constructor() {
    this.loadPromise = this.start().then(
      () => {
        this._ready = true
      },
      (err: unknown) => {
        this._error = err instanceof Error ? err.message : "load failed"
        // Re-throw so `whenReady()` rejects. NavMap's local hook treats
        // rejection as "stay grey"; swallowing here would flip `_ready`
        // true and crash on the first map construction.
        throw err
      },
    )
  }

  /** Resolves when `mapboxgl` is ready to construct a Map (token set). */
  whenReady(): Promise<void> {
    return this.loadPromise
  }

  get ready(): boolean {
    return this._ready
  }

  get error(): string | null {
    return this._error
  }

  /** The resolved Mapbox public token. Empty until `whenReady()` resolves. */
  get apiKey(): string {
    return this._apiKey
  }

  private async start(): Promise<void> {
    const token = await this.resolveToken()
    if (!token) {
      throw new Error("missing PUBLIC_MAPBOX_TOKEN")
    }
    this._apiKey = token
    mapboxgl.accessToken = token
  }

  private async resolveToken(): Promise<string> {
    // `bun run release` substitutes this at build time via define in
    // build.ts. `bun run dev` ships the source unchanged — `process` is
    // undefined in the WebView, so fall through to /api/config.
    try {
      const fromEnv = process.env.PUBLIC_MAPBOX_TOKEN
      if (fromEnv) {
        console.log("[NAV-MINI] mapbox token from build-time env")
        return fromEnv
      }
    } catch {
      // process is not defined in the dev WebView — fall through.
    }
    try {
      console.log("[NAV-MINI] mapbox token: fetching /api/config from origin", window.location.origin)
      const res = await fetch("/api/config")
      if (res.ok) {
        const {mapboxToken} = (await res.json()) as {mapboxToken?: string}
        if (!mapboxToken) console.warn("[NAV-MINI] /api/config returned no mapboxToken")
        return mapboxToken ?? ""
      }
      console.warn("[NAV-MINI] /api/config returned status", res.status)
    } catch (err) {
      console.warn("[NAV-MINI] /api/config fetch failed:", err)
    }
    return ""
  }
}

/** Singleton — one Mapbox init per WebView mount. */
let singleton: MapboxManager | null = null

/** Lazy initialiser. Callers await `whenReady()` directly. */
export function getMapbox(): MapboxManager {
  if (singleton) return singleton
  singleton = new MapboxManager()
  return singleton
}
