/**
 * Solid teardrop pin with an inner dot. Used in the first row of the
 * recent-searches list to highlight the most-recent location.
 */
export function PinIconFilled({
  size = 16,
  fill = "#FFFFFF",
  dotFill = "#1A1A1A",
}: {size?: number; fill?: string; dotFill?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" fill={fill} />
      <circle cx="12" cy="10" r="3" fill={dotFill} />
    </svg>
  )
}
