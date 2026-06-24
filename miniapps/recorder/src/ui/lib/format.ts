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
