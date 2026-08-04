/**
 * Reticle / crosshair icon — used by the "Use my current location" row
 * on AddPlacePage and the map's recenter button (with a different fill).
 */
export function CrosshairIcon({
  size = 12,
  color = "#1A1A1A",
  centerFill,
}: {size?: number; color?: string; centerFill?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="3" fill={centerFill ?? color} />
      <circle cx="12" cy="12" r="7" stroke={color} strokeWidth="1.6" />
      <path d="M12 1V4M12 20V23M1 12H4M20 12H23" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
