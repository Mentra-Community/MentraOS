/**
 * Minus sign — pairs with PlusIcon for the map's zoom-out button.
 */
export function MinusIcon({
  size = 20,
  color = "#000000D9",
  strokeWidth = 2.4,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M5 12H19" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}
