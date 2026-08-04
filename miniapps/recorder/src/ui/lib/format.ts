/** ms → m:ss (or h:mm:ss past an hour). */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Bytes → human size (KB / MB / GB). */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** ms → "0:10.7" (m:ss.tenths) for the live recording timer. */
export function fmtTimer(ms: number): string {
  const totalTenths = Math.floor(Math.max(0, ms) / 100)
  const tenths = totalTenths % 10
  const totalSeconds = Math.floor(totalTenths / 10)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60)
  return `${m}:${s.toString().padStart(2, "0")}.${tenths}`
}

/** Epoch ms → "Today • 1:41 PM" / "Yesterday • 2:41 PM" / "Jan 4, 2026". */
export function fmtRelative(epochMs: number): string {
  const d = new Date(epochMs)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  if (dayDiff === 0) return `Today • ${time}`
  if (dayDiff === 1) return `Yesterday • ${time}`
  return d.toLocaleDateString(undefined, {month: "short", day: "numeric", year: "numeric"})
}

/** Epoch ms → "Jan 6 at 2:55 PM" header timestamp. */
export function fmtDateTime(epochMs: number): string {
  const d = new Date(epochMs)
  const date = d.toLocaleDateString(undefined, {month: "short", day: "numeric"})
  const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  return `${date} at ${time}`
}

/** Epoch ms → "JANUARY 2026" group heading. */
export function monthGroup(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {month: "long", year: "numeric"}).toUpperCase()
}

/** Epoch ms → "Today 3:42 PM" / "Jun 24, 3:42 PM". */
export function fmtWhen(epochMs: number): string {
  const d = new Date(epochMs)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return `Today ${time}`
  const date = d.toLocaleDateString(undefined, {month: "short", day: "numeric"})
  return `${date}, ${time}`
}
