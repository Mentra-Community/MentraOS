/** Formatting + date-grouping helpers for the Gallery UI. */

import type {PhotoItem} from "../../shared/types"

/** Local-midnight epoch for grouping photos by day. */
export function dayKey(epochMs: number): number {
  const d = new Date(epochMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** `Today` / `Yesterday` / `Monday, Jun 23` / `Jun 6, 2026`. */
export function dayGroupLabel(epochMs: number): string {
  const d = new Date(epochMs)
  const now = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(now) - start(d)) / 86_400_000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  if (diff < 7) return d.toLocaleDateString(undefined, {weekday: "long", month: "short", day: "numeric"})
  return d.toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})
}

/** `Jun 24, 2026`. */
export function formatLongDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})
}

/** `09:41 AM`. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"})
}

/** `2.4 MB` / `812 KB` — for per-photo size. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** `0:12` / `1:08` — video duration badge. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${(s % 60).toString().padStart(2, "0")}`
}

/** `1.2 GB` / `340 MB` / `0 GB` — for the library-total in the header. */
export function formatUsage(bytes: number): string {
  if (!bytes) return "0 GB"
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export interface DayGroup {
  key: number
  label: string
  items: PhotoItem[]
}

/** Group a newest-first photo list into day sections (preserving order). */
export function groupByDay(photos: PhotoItem[]): DayGroup[] {
  const map = new Map<number, PhotoItem[]>()
  for (const p of photos) {
    const k = dayKey(p.createdAt)
    const arr = map.get(k)
    if (arr) arr.push(p)
    else map.set(k, [p])
  }
  return [...map.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, items]) => ({key, label: dayGroupLabel(key), items}))
}
