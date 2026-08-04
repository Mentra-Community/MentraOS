import {createContext, useContext, useMemo} from "react"
import type {ReactNode} from "react"
import {useMotionValue} from "motion/react"
import type {MotionValue} from "motion/react"

/**
 * Shared MotionValue published by every active `Drawer` describing how
 * tall its visible portion currently is, in pixels measured from the
 * bottom of the viewport. Consumers (e.g. the floating NavMap controls
 * stack) read this to anchor themselves above the drawer without
 * re-rendering on every drag frame — they bind a `motion.div` style
 * directly to the value.
 *
 * Only one drawer is mounted at a time on this page; that drawer is
 * the sole writer. When drawers swap (Idle → Preview → Running) the
 * incoming drawer reads the current value as its starting point and
 * animates from there to its own resting height, so the buttons slide
 * smoothly across the transition instead of snapping.
 */
type DrawerOffsetContextValue = {
  /** Pixels of drawer currently visible above the bottom edge. */
  visibleHeight: MotionValue<number>
}

const DrawerOffsetContext = createContext<DrawerOffsetContextValue | null>(null)

export function DrawerOffsetProvider({children}: {children: ReactNode}) {
  const visibleHeight = useMotionValue(0)
  const value = useMemo(() => ({visibleHeight}), [visibleHeight])
  return <DrawerOffsetContext.Provider value={value}>{children}</DrawerOffsetContext.Provider>
}

/**
 * Read the shared visible-height MotionValue. Returns `null` when the
 * caller isn't wrapped in a provider — components outside the
 * NavigationPage tree don't need this and shouldn't crash.
 */
export function useDrawerOffset(): MotionValue<number> | null {
  return useContext(DrawerOffsetContext)?.visibleHeight ?? null
}
