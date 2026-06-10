/**
 * Stylized checkmark used inside ArrivalDrawer's success badge.
 */
export function CheckIcon({
  size = 24,
  color = "#FFFFFF",
  strokeWidth = 2.6,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path
        d="M5 12.5L10 17.5L19 7.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
