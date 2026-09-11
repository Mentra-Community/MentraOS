/**
 * Outlined briefcase silhouette used on light surfaces — the slot-edit
 * dropdown on AddPlacePage.
 */
export function WorkIconOutline({
  size = 14,
  color = "#1A1A1A",
  strokeWidth = 2,
}: {size?: number; color?: string; strokeWidth?: number}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 7h16v13H4z M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
