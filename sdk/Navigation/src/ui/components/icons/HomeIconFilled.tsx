/**
 * Filled house silhouette used on dark backgrounds (saved-place chips
 * in LocationSearch, IdleDrawer's saved-place grid). The outlined
 * variant for use on light backgrounds lives in `HomeIconOutline.tsx`.
 */
export function HomeIconFilled({size = 16, color = "#FFFFFF"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M3 12 L12 4 L21 12 L21 20 H14 V14 H10 V20 H3 Z" fill={color} />
    </svg>
  )
}
