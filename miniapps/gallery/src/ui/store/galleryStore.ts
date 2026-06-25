/**
 * Gallery store — subscribes to the background channel bus once and fans the
 * latest state out to React. Persists across route changes (Grid ↔ Detail ↔
 * Settings) so navigation doesn't drop state or re-request on every mount.
 */

import {useEffect, useState} from "react"

import type {CaptureStatus, GallerySettings, GallerySnapshot} from "../../shared/types"

interface GalleryState {
  snapshot: GallerySnapshot | null
  status: CaptureStatus | null
}

let current: GalleryState = {snapshot: null, status: null}
const listeners = new Set<() => void>()
let wired = false

function set(next: GalleryState): void {
  current = next
  for (const l of listeners) l()
}

function ensureWired(): void {
  if (wired) return
  wired = true
  const on = mentra.on as (c: string, cb: (p: unknown) => void) => () => void
  on("gal:snapshot", (p) => set({...current, snapshot: p as GallerySnapshot}))
  on("gal:photos", (p) => {
    const {photos, usage} = p as {photos: GallerySnapshot["photos"]; usage: GallerySnapshot["usage"]}
    if (current.snapshot) set({...current, snapshot: {...current.snapshot, photos, usage}})
  })
  on("gal:status", (st) => {
    const status = st as CaptureStatus
    const snapshot = current.snapshot ? {...current.snapshot, capturing: status.capturing} : current.snapshot
    set({snapshot, status})
  })
  mentra.send("gal:request-snapshot", {})
}

export const galleryCommands = {
  capture: () => mentra.send("gal:capture", {}),
  deletePhotos: (ids: string[]) => mentra.send("gal:delete", {ids}),
  share: (id: string) => mentra.send("gal:share", {id}),
  favorite: (id: string, favorite: boolean) => mentra.send("gal:favorite", {id, favorite}),
  setSettings: (patch: Partial<GallerySettings>) => mentra.send("gal:set-settings", patch),
  clear: () => mentra.send("gal:clear", {}),
}

export function useGallery() {
  const [state, setState] = useState<GalleryState>(() => {
    ensureWired()
    return current
  })
  useEffect(() => {
    const listener = () => setState(current)
    listeners.add(listener)
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return {snapshot: state.snapshot, status: state.status, ...galleryCommands}
}
