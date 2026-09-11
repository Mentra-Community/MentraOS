/**
 * Plus sign for "add" affordances — IdleDrawer's add-place tile and
 * the map's zoom-in button. Stroke-only, no fill.
 */
export function PlusIcon({
  size = 14,
  color = "#000000",
  strokeWidth = 2.4,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 5V19M5 12H19" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}
