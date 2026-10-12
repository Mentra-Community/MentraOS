import {useEffect, useRef} from "react"

const WIDTH = 280
const PIXELS_PER_MS = 0.03

/** Per-slice audio energy, fixed in capture time. Only the horizontal time axis moves. */
export function Waveform({levels, paused = false}: {levels: Array<{ms: number; level: number}>; paused?: boolean}) {
  const track = useRef<SVGGElement>(null)
  const clock = useRef(0)
  const latestMs = levels[levels.length - 1]?.ms ?? 0

  useEffect(() => {
    if (!track.current) return
    if (paused) {
      clock.current ||= latestMs
      track.current.setAttribute("transform", `translate(${WIDTH - clock.current * PIXELS_PER_MS}, 0)`)
      return
    }
    const receivedAt = performance.now()
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let frame = 0
    const draw = (now: number) => {
      // Interpolate only the horizontal clock between 50ms audio deliveries.
      // Never smooth bar heights or invent motion when the audio feed stalls.
      const elapsed = reducedMotion ? 0 : Math.min(50, now - receivedAt)
      clock.current = Math.max(clock.current, latestMs + elapsed)
      track.current?.setAttribute("transform", `translate(${WIDTH - clock.current * PIXELS_PER_MS}, 0)`)
      if (!reducedMotion && elapsed < 50) frame = requestAnimationFrame(draw)
    }
    draw(receivedAt)
    return () => cancelAnimationFrame(frame)
  }, [latestMs, paused])

  return (
    <svg viewBox={`0 0 ${WIDTH} 100`} preserveAspectRatio="none" className="h-full w-full overflow-hidden" aria-hidden>
      <g ref={track} fill="var(--green)" opacity={paused ? 0.25 : 0.85}>
        {levels.map(({ms, level}, i) => {
          // Visual gain is 3x the original; reserve 2% padding at each panel edge.
          const height = Math.min(96, Math.max(1, (Number.isFinite(level) ? Math.max(0, level) : 0) * 180))
          const startMs = i > 0 ? levels[i - 1].ms : Math.max(0, ms - 50)
          return (
            <rect
              key={ms}
              x={startMs * PIXELS_PER_MS}
              y={(100 - height) / 2}
              width={Math.max(0.5, (ms - startMs) * PIXELS_PER_MS - 0.5)}
              height={height}
              rx={0.25}
            />
          )
        })}
      </g>
    </svg>
  )
}
