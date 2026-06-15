/**
 * Outlined house silhouette used on light surfaces. The slot-edit
 * dropdown on AddPlacePage uses this variant alongside its filled
 * sibling for legibility against the dark-on-light card style.
 */
export function HomeIconOutline({
  size = 14,
  color = "#1A1A1A",
  strokeWidth = 2,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M3 11l9-8 9 8v10a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2V11z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />
    </svg>
  )
}
