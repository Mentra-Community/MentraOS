import {AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, usePresence} from "motion/react"
import type {PanInfo} from "motion/react"
import {useEffect, useLayoutEffect, useRef, useState} from "react"
import type {ReactNode} from "react"

import {useDrawerOffset} from "@/ui/components/Drawer/DrawerOffsetContext"

/**
 * Generic bottom drawer with optional "peek" snap point.
 *
 * Visibility:
 * - `open=true`  → slides up.
 * - `open=false` → slides down.
 *
 * Snap behavior (when `peekHeight` is provided + `expanded` is controlled):
 * - The drawer ALWAYS renders its full `children`. In the peek state, it
 *   simply translates itself down by (expandedHeight − peekHeight), so
 *   only the bottom `peekHeight` pixels remain on-screen. Drag tracks
 *   that offset 1:1, so pulling the handle up reveals the whole drawer
 *   smoothly — exactly like iOS / Google Maps bottom sheets.
 * - Past the midpoint (or fast fling) → snaps to the other state.
 * - Drag down past peek (when `dismissOnSwipeDown`) → dismisses.
 *
 * The caller is responsible for laying out `children` so that the bottom
 * `peekHeight` pixels are an informative summary (handle + ETA/distance
 * line, etc.). The full body sits above it and is hidden when peeked.
 */

type Props = {
  open: boolean
  onClose: () => void
  /** Disable swipe-down-to-dismiss from the peek state. Default: enabled. */
  dismissOnSwipeDown?: boolean
  /** Pixels of the drawer that remain visible in the peek state. When
   *  unset, the drawer is single-state (always fully open). */
  peekHeight?: number
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  className?: string
  children: ReactNode
}

const SWIPE_VELOCITY_THRESHOLD = 500 // px/s — fling commits regardless of distance
const DISMISS_VELOCITY = 800 // px/s — only dismiss on fast flings down past peek

export function Drawer(props: Props) {
  return (
    <AnimatePresence>{props.open ? <DrawerInner key="drawer" {...props} /> : null}</AnimatePresence>
  )
}

/**
 * The actual drawer surface, mounted/unmounted by AnimatePresence around
 * the parent. We split this out so `usePresence` can drive enter/exit
 * via the SAME `y` motion value that drag uses — that way the
 * published visible-height (in DrawerOffsetContext) tracks the slide-
 * down-on-dismiss too, not just user drags. Without this split, exit
 * was driven by AnimatePresence on a separate outer motion.div, and our
 * y-subscription never saw it — so the right-rail buttons froze at the
 * dismiss-position and then flicked when the next drawer mounted.
 */
function DrawerInner({
  onClose,
  dismissOnSwipeDown = true,
  peekHeight,
  expanded = true,
  onExpandedChange,
  className,
  children,
}: Props) {
  const hasPeek = peekHeight !== undefined
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  // Measured height of the full drawer body. Updated whenever children
  // change so peek translation stays correct as content reflows.
  const [sheetHeight, setSheetHeight] = useState(0)

  useLayoutEffect(() => {
    if (!measureRef.current) return
    // Snapshot the ref so the cleanup closure doesn't read a possibly-
    // null `measureRef.current` after unmount.
    const node = measureRef.current
    const update = () => {
      const h = node.getBoundingClientRect().height
      if (h > 0) setSheetHeight(h)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  // The peek-state offset: how far down to translate the drawer so only
  // the bottom `peekHeight` is visible. Negative => fully expanded.
  const peekOffset = hasPeek && sheetHeight > 0 ? Math.max(0, sheetHeight - (peekHeight ?? 0)) : 0
  const restingY = expanded ? 0 : peekOffset

  // The drag motion value — animated programmatically when `expanded`
  // changes, manipulated directly during drag, AND used by usePresence
  // to drive the slide-up-on-mount / slide-down-on-unmount animations.
  // Initial value is large so the drawer starts off-screen below; the
  // mount effect immediately animates to `restingY`.
  const y = useMotionValue(typeof window !== "undefined" ? window.innerHeight : 1000)

  // Enter / exit animation. usePresence lets us defer unmount until our
  // exit animation completes — so we can drive the slide-down on the
  // SAME `y` motion value rather than letting AnimatePresence drive a
  // separate outer transform.
  const [isPresent, safeToRemove] = usePresence()

  // On mount + on every restingY change while present: animate y →
  // restingY. On exit: animate y → off-screen-below, then call
  // safeToRemove. This single y motion value carries the entire
  // lifecycle so our drawer-offset publishing sees every transition.
  useEffect(() => {
    if (isPresent) {
      const controls = animate(y, restingY, {type: "spring", stiffness: 320, damping: 42})
      return controls.stop
    } else {
      const target = typeof window !== "undefined" ? window.innerHeight : 1000
      const controls = animate(y, target, {
        type: "spring",
        stiffness: 320,
        damping: 42,
        onComplete: () => safeToRemove?.(),
      })
      return controls.stop
    }
  }, [isPresent, restingY, y, safeToRemove])

  // Publish current visible-height (in viewport pixels measured up from
  // the bottom edge) into the shared context so floating UI like the
  // NavMap right-rail buttons can anchor above the drawer without
  // re-rendering on every drag frame. Consumers wrap the value in a
  // spring so cross-drawer transitions ease smoothly. Computed as
  // `sheetHeight − y` because `y` is the drawer's drag-translate-down,
  // and the bottom of the drawer is always pinned to the viewport
  // bottom.
  const drawerOffset = useDrawerOffset()
  useMotionValueEvent(y, "change", (latest) => {
    if (!drawerOffset) return
    const visible = Math.max(0, sheetHeight - latest)
    drawerOffset.set(visible)
  })
  // Also republish when sheetHeight itself changes (first measurement,
  // content reflow) — the y subscription only fires on y changes.
  // useLayoutEffect (not useEffect) so the new drawer's height is in
  // the shared MotionValue BEFORE the browser paints — otherwise on
  // drawer-swap the right-rail buttons render one frame at the previous
  // drawer's height.
  useLayoutEffect(() => {
    if (!drawerOffset) return
    const visible = Math.max(0, sheetHeight - y.get())
    drawerOffset.set(visible)
  }, [sheetHeight, drawerOffset, y])

  function onDragEnd(_: unknown, info: PanInfo) {
    const velocity = info.velocity.y
    const current = y.get()

    if (!hasPeek) {
      // Single-state drawer: drag-down dismisses; everything else snaps back.
      if (dismissOnSwipeDown && (current > 80 || velocity > SWIPE_VELOCITY_THRESHOLD)) {
        onClose()
      } else {
        animate(y, 0, {type: "spring", stiffness: 320, damping: 42})
      }
      return
    }

    // Two-state drawer. Snap based on which side of the midpoint we're
    // on, with velocity allowed to override.
    const midpoint = peekOffset / 2
    let nextExpanded: boolean
    if (velocity < -SWIPE_VELOCITY_THRESHOLD) nextExpanded = true
    else if (velocity > SWIPE_VELOCITY_THRESHOLD) nextExpanded = false
    else nextExpanded = current < midpoint

    // Drag past peek — dismiss only on fast flings, not on slow drags
    // (slow drags just snap back to peek so users don't lose the trip
    //  by accident).
    if (dismissOnSwipeDown && !nextExpanded && current > peekOffset && velocity > DISMISS_VELOCITY) {
      onClose()
      return
    }

    if (nextExpanded !== expanded) {
      onExpandedChange?.(nextExpanded)
    } else {
      animate(y, nextExpanded ? 0 : peekOffset, {type: "spring", stiffness: 320, damping: 42})
    }
  }

  function onHandleTap() {
    if (hasPeek) {
      onExpandedChange?.(!expanded)
    } else {
      onClose()
    }
  }

  return (
    <div className="fixed left-0 right-0 bottom-0 z-40 pointer-events-none">
      <motion.div
        ref={sheetRef}
        drag="y"
        dragConstraints={{top: 0, bottom: hasPeek ? peekOffset : 0}}
        dragElastic={{top: 0, bottom: hasPeek ? 0.25 : 0.6}}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        style={{y}}
        className="relative">
        <div
          ref={measureRef}
          className={
            className ??
            "pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[22px] rounded-tr-[22px] bg-[#F5F1E8] dark:bg-zinc-900 [box-shadow:#1F1F1B0F_0px_-2px_16px] antialiased"
          }>
          <DrawerHandleInternal onTap={onHandleTap} />
          {children}
        </div>
      </motion.div>
    </div>
  )
}

function DrawerHandleInternal({onTap}: {onTap: () => void}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="w-full flex justify-center pt-4 pb-4"
      aria-label="Drawer handle">
      <div className="w-9 h-1 rounded-full bg-[#00000033] dark:bg-[#FFFFFF4D]" />
    </button>
  )
}

/**
 * @deprecated Handle is rendered internally by `Drawer` now. Renders
 * nothing; safe to remove from callers.
 */
export function DrawerHandle(_: {onTap?: () => void}) {
  return null
}
