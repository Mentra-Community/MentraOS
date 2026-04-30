import {AnimatePresence, animate, motion, useMotionValue} from "motion/react"
import type {PanInfo} from "motion/react"
import {useEffect, useLayoutEffect, useRef, useState} from "react"
import type {ReactNode} from "react"

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

export function Drawer({
  open,
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
  }, [open])

  // The peek-state offset: how far down to translate the drawer so only
  // the bottom `peekHeight` is visible. Negative => fully expanded.
  const peekOffset = hasPeek && sheetHeight > 0 ? Math.max(0, sheetHeight - (peekHeight ?? 0)) : 0
  const restingY = expanded ? 0 : peekOffset

  // The drag motion value — animated programmatically when `expanded`
  // changes, manipulated directly during drag.
  const y = useMotionValue(restingY)

  // Animate to the new resting position whenever `expanded` flips, OR
  // whenever the measured height changes (so we don't show a wrong
  // offset on first paint).
  useEffect(() => {
    const controls = animate(y, restingY, {type: "spring", stiffness: 320, damping: 42})
    return controls.stop
  }, [restingY, y])

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

  // When peek is enabled we punch a 48px circular hole in the top-right of
  // the cream surface (so the map shows through) and float a chevron
  // toggle inside it. Mask geometry: opaque everywhere EXCEPT a circle
  // centered at (right - HOLE_INSET, HOLE_INSET) of radius HOLE_RADIUS.
  // The hole/chevron must sit fully inside the cream surface, so
  // `HOLE_TOP_INSET >= HOLE_RADIUS`. Otherwise the cut and button extend
  // past the drawer's rounded top edge and look like detached chrome.
  const HOLE_RADIUS = 22 // px (44px diameter)
  const HOLE_TOP_INSET = 6 // 4px gap between top of cream and top of hole
  const HOLE_RIGHT_INSET = 32 // distance from right edge to circle center
  const surfaceMaskStyle = hasPeek
    ? ({
        WebkitMaskImage: `radial-gradient(circle ${HOLE_RADIUS}px at calc(100% - ${HOLE_RIGHT_INSET}px) ${HOLE_TOP_INSET}px, transparent 99%, black 100%)`,
        maskImage: `radial-gradient(circle ${HOLE_RADIUS}px at calc(100% - ${HOLE_RIGHT_INSET}px) ${HOLE_TOP_INSET}px, transparent 99%, black 100%)`,
      } as const)
    : undefined

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="drawer"
          initial={{y: "100%"}}
          animate={{y: 0}}
          exit={{y: "100%"}}
          transition={{type: "spring", stiffness: 320, damping: 42}}
          className="fixed left-0 right-0 bottom-0 z-40 pointer-events-none">
          <motion.div
            ref={sheetRef}
            drag="y"
            dragConstraints={{top: 0, bottom: hasPeek ? peekOffset : 0}}
            dragElastic={{top: 0.15, bottom: hasPeek ? 0.25 : 0.6}}
            dragMomentum={false}
            onDragEnd={onDragEnd}
            style={{y}}
            className="relative">
            <div
              style={surfaceMaskStyle}
              className={
                className ??
                "pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[22px] rounded-tr-[22px] bg-[#F5F1E8] [box-shadow:#1F1F1B0F_0px_-2px_16px] antialiased"
              }>
              <div ref={measureRef}>
                <DrawerHandleInternal onTap={onHandleTap} />
                {children}
              </div>
            </div>
            {hasPeek ? (
              <div className="pointer-events-none absolute inset-0 mx-auto max-w-md">
                <ChevronToggle
                  expanded={expanded}
                  onClick={() => onExpandedChange?.(!expanded)}
                  top={HOLE_TOP_INSET}
                  right={HOLE_RIGHT_INSET}
                  radius={HOLE_RADIUS}
                />
              </div>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function ChevronToggle({
  expanded,
  onClick,
  top,
  right,
  radius,
}: {
  expanded: boolean
  onClick: () => void
  top: number
  right: number
  radius: number
}) {
  const size = radius * 2 - 4 // slight inset so the button sits inside the hole
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: top - size / 2,
        right: right - size / 2,
        width: size,
        height: size,
      }}
      className="pointer-events-auto rounded-full bg-[#F5F1E8] border border-[#E4DECD] shadow-sm flex items-center justify-center text-[#1F1F1B] z-10"
      aria-label={expanded ? "Collapse drawer" : "Expand drawer"}>
      <motion.svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        animate={{rotate: expanded ? 180 : 0}}
        transition={{type: "spring", stiffness: 340, damping: 28}}>
        <path
          d="M6 14l6-6 6 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.svg>
    </button>
  )
}

function DrawerHandleInternal({onTap}: {onTap: () => void}) {
  return (
    <button
      type="button"
      onClick={onTap}
      className=""
      aria-label="Drawer handle">
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
