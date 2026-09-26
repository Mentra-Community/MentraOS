/**
 * @fileoverview useHistoryState — `useState` whose changes are browser history
 * entries, so the phone's back gesture steps back through them.
 *
 * The host sends the back gesture (iOS edge swipe, Android back) to the
 * miniapp's WebView history first, and minimizes the miniapp only once that
 * history is empty. Screens, tabs and dialogs kept in plain React state never
 * create history, so back skips past them and minimizes the whole miniapp.
 * This hook keeps its value in `history.state` instead:
 *
 * - Setting a new value pushes a history entry. Back pops it, and the hook
 *   re-renders with the previous value.
 * - Setting the value back to what it was before its latest change(s) goes
 *   back instead of pushing. Closing a dialog with its own button therefore
 *   consumes the dialog's entry, and the next back gesture does not reopen it.
 *
 * Routers in hash or browser mode (react-router's `HashRouter`, wouter's
 * `useHashLocation`) already create history for pages; use this hook for UI
 * state that is not a route. Every hook on the page shares one history entry
 * per step, and `key` names the value within it, so components passing the
 * same key share the same value. Values are stored as structured clones.
 */

import {useCallback, useRef, useSyncExternalStore} from "react"

const STATE_KEY = "__mentraHistoryState"

interface Entry {
  values: Record<string, unknown>
  /** One record per entry this hook pushed, oldest first, with the value it replaced. */
  trail: Array<{key: string; previous: unknown}>
}

const EMPTY: Entry = {values: {}, trail: []}

let cachedState: unknown = null
let cachedEntry: Entry = EMPTY

/** This hook's slice of the current entry, cached so snapshots stay referentially stable. */
function currentEntry(): Entry {
  if (typeof window === "undefined") return EMPTY
  const state: unknown = window.history.state
  if (state !== cachedState) {
    cachedState = state
    cachedEntry = (state as Record<string, Entry | undefined> | null)?.[STATE_KEY] ?? EMPTY
  }
  return cachedEntry
}

const listeners = new Set<() => void>()
let boundWindow: Window | null = null
// history.go() lands later, on popstate. A change applied before then would
// push on top of the entry being left, and the traversal would pop that push
// instead, so changes wait in order until the traversal lands.
let traversing = false
const pending: Array<() => void> = []

function notify() {
  listeners.forEach((listener) => listener())
}

function flush() {
  while (!traversing && pending.length > 0) pending.shift()!()
}

function onPopState() {
  traversing = false
  notify()
  // Let every popstate listener, including the host's history bridge, see the
  // landed entry before a waiting change pushes the next one.
  setTimeout(flush, 0)
}

function subscribe(listener: () => void): () => void {
  if (boundWindow !== window) {
    boundWindow?.removeEventListener("popstate", onPopState)
    window.addEventListener("popstate", onPopState)
    boundWindow = window
    traversing = false
    pending.length = 0
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function whenSettled(change: () => void) {
  if (traversing || pending.length > 0) pending.push(change)
  else change()
}

function apply(key: string, initialValue: unknown, update: unknown) {
  const {values, trail} = currentEntry()
  const current = key in values ? values[key] : initialValue
  const next = typeof update === "function" ? (update as (previous: unknown) => unknown)(current) : update
  if (Object.is(current, next)) return
  for (let index = trail.length - 1; index >= 0 && trail[index].key === key; index--) {
    if (Object.is(trail[index].previous, next)) {
      traversing = true
      window.history.go(index - trail.length)
      return
    }
  }
  // Keep other fields (a router's index, the host's depth marker) on the new entry.
  const state: unknown = window.history.state
  const base = state !== null && typeof state === "object" ? state : {}
  const entry: Entry = {values: {...values, [key]: next}, trail: [...trail, {key, previous: current}]}
  window.history.pushState({...base, [STATE_KEY]: entry}, "")
  notify()
}

export type SetHistoryState<T> = (value: T | ((previous: T) => T)) => void

/**
 * Like `useState`, but each change is a history entry that the phone's back
 * gesture undoes. `key` names the value in history state and must be unique
 * per piece of state on the page.
 *
 * ```tsx
 * const [tab, setTab] = useHistoryState<"home" | "settings">("tab", "home")
 * const [pickerOpen, setPickerOpen] = useHistoryState("languagePicker", false)
 * ```
 */
export function useHistoryState<T>(key: string, initialValue: T): [T, SetHistoryState<T>] {
  const initialRef = useRef(initialValue)
  const read = () => {
    const {values} = currentEntry()
    return (key in values ? values[key] : initialRef.current) as T
  }
  const value = useSyncExternalStore(subscribe, read, () => initialRef.current)
  const setValue = useCallback<SetHistoryState<T>>(
    (update) => whenSettled(() => apply(key, initialRef.current, update)),
    [key],
  )
  return [value, setValue]
}
