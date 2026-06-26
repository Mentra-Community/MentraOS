/**
 * Live green bar waveform driven by the rolling capture levels. Bars are
 * vertically centered (so they extend up AND down from the midline) and each
 * bar continuously oscillates (scaleY) for a lively "moving" waveform; the
 * newest sample sits on the right and older bars fade slightly.
 */
export function Waveform({levels, paused = false}: {levels: number[]; paused?: boolean}) {
  const n = levels.length
  return (
    <div className="flex items-center justify-center gap-[2px] h-full w-full">
      {levels.map((lv, i) => {
        const height = Math.max(6, Math.min(100, lv * 140))
        const recency = n > 1 ? i / (n - 1) : 1
        const opacity = paused ? 0.25 : 0.42 + 0.58 * recency
        return (
          <span
            key={i}
            className={`w-[3px] shrink-0 rounded-full ${paused ? "" : "wave-bar"}`}
            style={{
              height: `${height}%`,
              background: "var(--green-grad)",
              opacity,
              boxShadow: paused ? "none" : "0 0 6px color-mix(in srgb, var(--green) 35%, transparent)",
              animationDelay: `${(i % 7) * 90}ms`,
            }}
          />
        )
      })}
      {n === 0 ? (
        <span className="text-[13px]" style={{color: "var(--text-muted)"}}>
          Listening…
        </span>
      ) : null}
    </div>
  )
}
