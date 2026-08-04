/**
 * Outlined teardrop pin WITH the inner dot also outlined — the search-
 * input's leading affordance on AddPlacePage. Distinguished from
 * `PinIconOutline` (no dot) and `PinIconFilled` (fully filled with a
 * filled dot).
 */
export function PinIconOutlineWithDot({
  size = 18,
  color = "#1A1A1A",
  strokeWidth = 2,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path
        d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <circle cx="12" cy="10" r="3" stroke={color} strokeWidth={strokeWidth} fill="none" />
    </svg>
  )
}
