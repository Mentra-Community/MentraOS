/**
 * Small "x" icon used by the search-bar clear button and similar close
 * affordances. Stroke-only — no fill.
 */
export function CloseIcon({size = 10, color = "#737373"}: {size?: number; color?: string}) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 1L9 9M9 1L1 9" stroke={color} strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}
