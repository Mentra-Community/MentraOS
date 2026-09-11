/**
 * Dev-override toggle.
 *
 * Production builds default to hiding the FloatingDevPanel and other
 * dev-only chrome (debug map overlays, etc). This lets a power user
 * explicitly enable that chrome at runtime — useful for debugging a
 * released build without re-cutting it from source.
 *
 * Triggered by a 5-second hold on the search bar (see NavigationPage).
 * No visible feedback during the hold; persists across reloads via
 * localStorage so the user only has to do the gesture once. Holding
 * again toggles back off.
 *
 * The flag has NO effect in dev builds — `isDev` is already true there,
 * so the panel shows regardless. This file only matters in production.
 */

import {useEffect, useState} from "react"

const STORAGE_KEY = "nav:dev_override"
const EVENT_NAME = "nav:dev_override_changed"

function readFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1"
  } catch {
    // localStorage can throw in private-browsing or sandboxed contexts.
    // Falling back to false is the conservative call — worst case, the
    // user can re-do the gesture.
    return false
  }
}

function writeFlag(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "1")
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Same caveat — silently ignore.
  }
  // Notify subscribers in this WebView. `storage` events only fire
  // across windows/tabs, which doesn't apply here, so we publish our
  // own event for the hook to listen on.
  try {
    window.dispatchEvent(new Event(EVENT_NAME))
  } catch {
    // ignore
  }
}

/**
 * Read the current override state. SSR-safe (returns false on the server).
 * Most callers should prefer `useDevOverride()` which re-renders on
 * change; use this in non-reactive paths only.
 */
export function getDevOverride(): boolean {
  if (typeof window === "undefined") return false
  return readFlag()
}

/** Flip the override. Persists immediately. */
export function toggleDevOverride(): boolean {
  const next = !readFlag()
  writeFlag(next)
  return next
}

/**
 * React hook — returns the current override state and re-renders when
 * it changes. Subscribes to the in-WebView custom event so toggles from
 * anywhere in the app (the long-press handler, a future settings
 * button) update every consumer.
 */
export function useDevOverride(): boolean {
  const [on, setOn] = useState<boolean>(() => getDevOverride())
  useEffect(() => {
    const handler = () => setOn(readFlag())
    window.addEventListener(EVENT_NAME, handler)
    return () => window.removeEventListener(EVENT_NAME, handler)
  }, [])
  return on
}
