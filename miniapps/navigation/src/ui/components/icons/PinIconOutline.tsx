/**
 * Outlined teardrop pin, no inner dot. Used for non-highlighted rows in
 * the recent-searches and autocomplete-suggestions lists.
 */
export function PinIconOutline({
  size = 18,
  color = "#000000A6",
  strokeWidth = 1.8,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path
        d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z"
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
      />
    </svg>
  )
}
