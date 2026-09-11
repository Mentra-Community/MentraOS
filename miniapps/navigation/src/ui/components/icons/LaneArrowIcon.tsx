/**
 * Small directional arrow used by OrientationCard's lane-guidance row.
 * `direction` picks one of three paths — left, right, or straight up.
 * `highlight=true` darkens the stroke to mark "your lane" vs the
 * inactive grey siblings.
 */
export function LaneArrowIcon({
  direction,
  highlight,
  size = 20,
}: {
  direction: "left" | "straight" | "right"
  highlight: boolean
  size?: number
}) {
  const color = highlight ? "#111111" : "#9CA3AF"
  const path =
    direction === "left"
      ? "M14 4 L4 12 L14 20 M4 12 L20 12"
      : direction === "right"
        ? "M10 4 L20 12 L10 20 M20 12 L4 12"
        : "M12 4 L12 20 M6 10 L12 4 L18 10"
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d={path} stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
