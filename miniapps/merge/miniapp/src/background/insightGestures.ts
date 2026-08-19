export type InsightGestureAction = "dismiss" | "expand" | null

/**
 * Translate host touch names into the two actions available while an insight
 * is visible. The back alias keeps dismissal compatible with hosts that expose
 * the physical temple-pad direction instead of the SDK's down-swipe name.
 */
export function insightGestureAction(kind: string): InsightGestureAction {
  switch (kind) {
    case "swipe_down":
    case "swipe_back":
      return "dismiss"
    case "single_tap":
    case "tap":
      return "expand"
    default:
      return null
  }
}
