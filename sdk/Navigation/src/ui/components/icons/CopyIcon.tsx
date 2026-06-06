/**
 * Two stacked rectangles representing a copy-to-clipboard affordance.
 * Used in DestinationPreviewDrawer next to the address row.
 */
export function CopyIcon({
  size = 16,
  color = "#000000A6",
  strokeWidth = 1.8,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="9" width="11" height="11" rx="2.5" stroke={color} strokeWidth={strokeWidth} />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}
