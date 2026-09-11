/**
 * Left-pointing chevron used by header back buttons.
 */
export function BackChevronIcon({size = 18, color = "#1A1A1A"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 19L8 12L15 5" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
