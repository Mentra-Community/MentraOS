/**
 * Compass / GPS-recenter icon used on the map's "recenter on me"
 * button. The inner dot fills with a brand blue when follow-mode is
 * active so users get visual feedback.
 */
export function RecenterIcon({
  size = 20,
  active = false,
  activeFill = "#0A84FF",
  inactiveFill = "#1a1a1a",
  ringColor = "#000000D9",
}: {
  size?: number
  active?: boolean
  activeFill?: string
  inactiveFill?: string
  ringColor?: string
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="3" fill={active ? activeFill : inactiveFill} />
      <circle cx="12" cy="12" r="7" stroke={ringColor} strokeWidth="1.6" />
      <path d="M12 1V4M12 20V23M1 12H4M20 12H23" stroke={ringColor} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
