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
  if (t === "ARRIVE")
    return svg(
      <>
        <circle cx="40" cy="34" r="12" fill={color} />
        <path d="M40 46 L40 66" stroke={color} strokeWidth="8" strokeLinecap="round" />
        <circle cx="40" cy="34" r="5" fill="#5AC878" />
      </>,
    )

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
