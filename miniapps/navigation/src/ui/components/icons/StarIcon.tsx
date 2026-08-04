/**
 * Five-pointed star, fully filled. Used both as a small-dark accent in
 * IdleDrawer (default #000000D9 fill) and as a white saved-place chip
 * marker in LocationSearch (override color="#FFFFFF").
 */
export function StarIcon({size = 14, color = "#000000D9"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
        fill={color}
      />
    </svg>
  )
}
