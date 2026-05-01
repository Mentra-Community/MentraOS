/**
 * GoogleMapsManager
 *
 * Loads the Google Maps JS API exactly once for the app and exposes a
 * `whenReady(): Promise<void>` so callers can await before touching
 * `window.google.maps`. Production build inlines the API key via
 * `define` in build.ts; dev fetches `/api/config` from the local server.
 */

declare global {
  interface Window {
    google?: any
  }
}

export class GoogleMapsManager {
  private loadPromise: Promise<void>
  private _ready = false
  private _error: string | null = null

  constructor() {
    this.loadPromise = this.start().then(
      () => {
        this._ready = true
      },
      (err: unknown) => {
        this._error = err instanceof Error ? err.message : "load failed"
        // Don't propagate — callers poll `error` instead of catching.
      },
    )
  }

  /** Resolves when `window.google.maps` is safe to touch. */
  whenReady(): Promise<void> {
    return this.loadPromise
  }

  get ready(): boolean {
    return this._ready
  }

  get error(): string | null {
    return this._error
  }

  private async start(): Promise<void> {
    const apiKey = await this.resolveApiKey()
    if (!apiKey) {
      throw new Error("missing EXPO_PUBLIC_GOOGLE_NAV_API_KEY")
    }
    await this.loadScript(apiKey)
  }

  private async resolveApiKey(): Promise<string> {
    // `bun run release` substitutes this at build time via define in
    // build.ts. `bun run dev` ships the source unchanged — `process` is
    // undefined in the WebView, so fall through to /api/config.
    try {
      const fromEnv = process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY
      if (fromEnv) return fromEnv
    } catch {
      // process is not defined in the dev WebView — fall through.
    }
    try {
      const res = await fetch("/api/config")
      if (res.ok) {
        const {googleMapsApiKey} = (await res.json()) as {googleMapsApiKey?: string}
        return googleMapsApiKey ?? ""
      }
    } catch {
      // /api/config not reachable — give up.
    }
    return ""
  }

  private loadScript(apiKey: string): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve()
    if (window.google?.maps) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=geometry&v=weekly`
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
      if (existing) {
        existing.addEventListener("load", () => resolve())
        existing.addEventListener("error", () => reject(new Error("Google Maps script load failed")))
        return
      }
      const script = document.createElement("script")
      script.src = src
      script.async = true
      script.defer = true
      script.addEventListener("load", () => resolve())
      script.addEventListener("error", () => reject(new Error("Google Maps script load failed")))
      document.head.appendChild(script)
    })
  }
}
