/**
 * Outlined clock face — analog dial with hour/minute hands meeting at
 * 12:00. Used by IdleDrawer for the recent-searches header.
 */
export function ClockIcon({size = 14, color = "#000000D9"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" fill="none" />
      <path d="M12 7V12L15 14" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
