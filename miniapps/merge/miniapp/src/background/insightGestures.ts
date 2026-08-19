export type InsightGestureAction = "dismiss" | "expand" | null

/**
 * Translate host touch names into the two actions available while an insight
 * is visible. Forward/back aliases keep this compatible with hosts that expose
 * the physical temple-pad direction instead of the SDK's up/down names.
 */
export function insightGestureAction(kind: string): InsightGestureAction {
  switch (kind) {
    case "swipe_down":
    case "swipe_back":
      return "dismiss"
    case "swipe_up":
    case "swipe_forward":
      return "expand"
    default:
      return null
  }
}
