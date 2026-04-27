import {useEffect, useState} from "react"

declare global {
  interface Window {
    google?: any
  }
}

type LoadState = {ready: boolean; error: string | null}

let loadPromise: Promise<void> | null = null

async function resolveApiKey(): Promise<string> {
  // `bun run release` substitutes this at build time via define in build.ts —
  // produces a string literal in the bundle. `bun run dev` ships the source
  // unchanged, so `process` is undefined in the WebView at runtime; fall
  // through to the dev-server's /api/config endpoint in that case.
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
    // /api/config not reachable (release build with no server) — give up.
  }
  return ""
}

async function loadScript(apiKey: string): Promise<void> {
  if (typeof window === "undefined") return
  if (window.google?.maps) return
  if (loadPromise) return loadPromise

  loadPromise = new Promise((resolve, reject) => {
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
  return loadPromise
}

export function useGoogleMaps(): LoadState {
  const [state, setState] = useState<LoadState>({ready: false, error: null})

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const googleMapsApiKey = await resolveApiKey()
        if (!googleMapsApiKey) {
          if (!cancelled) setState({ready: false, error: "missing EXPO_PUBLIC_GOOGLE_NAV_API_KEY"})
          return
        }
        await loadScript(googleMapsApiKey)
        if (!cancelled) setState({ready: true, error: null})
      } catch (err) {
        if (!cancelled) {
          setState({ready: false, error: err instanceof Error ? err.message : "load failed"})
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}
