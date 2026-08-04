import type {ReactNode} from "react"

/**
 * Large maneuver arrow used by OrientationCard for the on-screen
 * turn-by-turn directive. Six visual variants:
 *   - TURN_RIGHT / SLIGHT_RIGHT / SHARP_RIGHT
 *   - TURN_LEFT  / SLIGHT_LEFT  / SHARP_LEFT / U_TURN
 *   - ARRIVE
 *   - STRAIGHT (default / continue / unrecognized)
 *
 * `stroke=true` swaps to an outlined "ghost" rendering (dark stroke,
 * no fill) for use on light glass surfaces. Filled mode uses the
 * card's cream color by default.
 */
export function ManeuverIcon({
  type,
  size = 32,
  stroke = false,
}: {
  type: string
  size?: number
  stroke?: boolean
}) {
  const t = type.toUpperCase()
  const color = stroke ? "#000000D9" : "#FBF6E8"
  const sw = stroke ? 6 : 0

  const svg = (path: ReactNode) => (
    <svg width={size} height={size} viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      {path}
    </svg>
  )

  if (t === "TURN_RIGHT" || t === "SLIGHT_RIGHT" || t === "SHARP_RIGHT")
    return svg(
      <path
        d="M18 56 L18 38 Q18 26 30 26 L52 26 L52 14 L72 32 L52 50 L52 38 L34 38 L34 56 Z"
        fill={stroke ? "none" : color}
        stroke={stroke ? color : undefined}
        strokeWidth={sw}
        strokeLinejoin="round"
      />,
    )
  if (t === "TURN_LEFT" || t === "SLIGHT_LEFT" || t === "SHARP_LEFT" || t === "U_TURN")
    return svg(
      <path
        d="M62 56 L62 38 Q62 26 50 26 L28 26 L28 14 L8 32 L28 50 L28 38 L46 38 L46 56 Z"
        fill={stroke ? "none" : color}
        stroke={stroke ? color : undefined}
        strokeWidth={sw}
        strokeLinejoin="round"
      />,
    )
  if (t === "ARRIVE") {
    // Pin glyph from public/assets/dest.svg, inlined here so it can be
    // recolored to match the cream/stroked palette the rest of the
    // arrows use. Source viewBox is 0 0 48 48; we render inside the
    // shared 0 0 80 80 viewport via a centered transform (scale ~1.4,
    // translated to center the 48×48 art at (40,40)).
    return svg(
      <g transform="translate(6.4 6.4) scale(1.4)">
        <path
          d="M24 8 C17 8 12 13 12 20 C12 28 24 40 24 40 C24 40 36 28 36 20 C36 13 31 8 24 8 Z"
          fill={stroke ? "none" : color}
          stroke={stroke ? color : undefined}
          strokeWidth={stroke ? sw / 1.4 : 0}
          strokeLinejoin="round"
        />
        <circle cx="24" cy="20" r="4" fill="#5AC878" />
      </g>,
    )
  }

  // Straight / continue / default
  if (stroke)
    return svg(
      <path
        d="M40 64 L40 28 L24 36 L40 12 L56 36 L40 28"
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />,
    )
  return svg(<path d="M32 62 L32 32 L20 32 L40 10 L60 32 L48 32 L48 62 Z" fill={color} />)
}
