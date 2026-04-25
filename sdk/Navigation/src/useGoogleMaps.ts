import {useEffect, useState} from "react"

declare global {
  interface Window {
    google?: any
  }
}

type LoadState = {ready: boolean; error: string | null}

let loadPromise: Promise<void> | null = null

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
        const res = await fetch("/api/config")
        const {googleMapsApiKey} = (await res.json()) as {googleMapsApiKey: string}
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
