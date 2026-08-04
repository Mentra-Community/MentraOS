/** Seconds → "m:ss". */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, "0")}`
}

/** "1 word" / "240 words". */
export function fmtWords(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "word" : "words"}`
}
