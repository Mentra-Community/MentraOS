/**
 * Filled briefcase silhouette used on dark backgrounds (saved-place
 * chips in LocationSearch, IdleDrawer's saved-place grid).
 */
export function WorkIconFilled({size = 16, color = "#FFFFFF"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <rect x="3" y="8" width="18" height="13" rx="1.5" fill={color} />
      <path d="M9 8 V5 H15 V8" stroke={color} strokeWidth="2" fill="none" />
    </svg>
  )
}
