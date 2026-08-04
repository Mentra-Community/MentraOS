/**
 * A simple symmetric bar-graph input meter driven by the 0–1 capture level.
 * Bars near the center light first; the lit width tracks the level.
 */
const BARS = 21

export function LevelMeter({level}: {level: number}) {
  const clamped = Math.max(0, Math.min(1, level))
  const center = (BARS - 1) / 2
  const litRadius = clamped * center

  return (
    <div className="flex items-center justify-center gap-[3px] h-full" aria-hidden>
      {Array.from({length: BARS}, (_, i) => {
        const dist = Math.abs(i - center)
        const lit = dist <= litRadius
        // Taller toward the center for a waveform feel.
        const h = 6 + Math.round((1 - dist / center) * 22)
        return (
          <span
            key={i}
            className="rounded-full transition-all duration-75"
            style={{
              width: 3,
              height: h,
              background: lit ? "var(--accent)" : "var(--border)",
              opacity: lit ? 1 : 0.6,
            }}
          />
        )
      })}
    </div>
  )
}
