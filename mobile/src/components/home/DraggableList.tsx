import React, {memo, useCallback, useEffect, useMemo, useRef, useState} from "react"
import {LayoutChangeEvent, StyleProp, StyleSheet, View, ViewStyle} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {
  cancelAnimation,
  SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated"
import {scheduleOnRN} from "react-native-worklets"

// ============================================================================
// Types — kept compatible with react-native-draggable-masonry
// ============================================================================

export interface DraggableItem {
  id: string
  height: number
  [key: string]: any
}

export interface RenderItemInfo<T extends DraggableItem> {
  item: T
  index: number
}

export type OverDragType = "both" | "horizontal" | "vertical" | "none"

export interface DragStartParams {
  key: string
  fromIndex: number
}
export interface DragEndParams<T extends DraggableItem> {
  key: string
  fromIndex: number
  toIndex: number
  data: T[]
}
export interface DragChangeParams {
  key: string
  x: number
  y: number
  index: number
}
export interface OrderChangeParams {
  key: string
  fromIndex: number
  toIndex: number
}

export interface DraggableListProps<T extends DraggableItem> {
  data: T[]
  renderItem: (info: RenderItemInfo<T>) => React.ReactNode
  keyExtractor?: (item: T) => string

  sortEnabled?: boolean

  // Accepted for API parity, but this implementation is swap-mode only.
  swapMode?: boolean

  columns?: number
  rowGap?: number
  columnGap?: number

  dragActivationDelay?: number
  activationAnimationDuration?: number
  dropAnimationDuration?: number
  overDrag?: OverDragType

  activeItemScale?: number
  activeItemOpacity?: number
  activeItemShadowOpacity?: number
  inactiveItemOpacity?: number
  inactiveItemScale?: number

  // Accepted for API parity (no-op).
  showDropIndicator?: boolean
  dropIndicatorStyle?: StyleProp<ViewStyle>

  onDragStart?: (params: DragStartParams) => void
  onDragEnd?: (params: DragEndParams<T>) => void
  onOrderChange?: (params: OrderChangeParams) => void
  onDragChange?: (params: DragChangeParams) => void

  contentContainerStyle?: StyleProp<ViewStyle>

  /** How far (0..1) the hovered item nudges toward the dragger's origin slot. */
  nudgeFraction?: number
  /** Extra delay (ms) after drop animation before committing the new order. */
  commitDelayMs?: number
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  columns: 2,
  rowGap: 10,
  columnGap: 10,
  sortEnabled: true,
  dragActivationDelay: 300,
  activationAnimationDuration: 150,
  dropAnimationDuration: 220,
  overDrag: "both" as OverDragType,
  activeItemScale: 1.06,
  activeItemOpacity: 1,
  activeItemShadowOpacity: 0.25,
  inactiveItemOpacity: 1,
  inactiveItemScale: 1,
  nudgeFraction: 24,
  commitDelayMs: 1500,
}

// Worklet-safe: convert (x, y) inside grid into the cell index directly under
// the pointer (swap mode — pick the cell, not the gap).
function locationToIndex(
  x: number,
  y: number,
  columns: number,
  cellW: number,
  cellH: number,
  itemCount: number,
): number {
  "worklet"
  const col = Math.max(0, Math.min(columns - 1, Math.floor(x / cellW)))
  const row = Math.max(0, Math.floor(y / cellH))
  const idx = row * columns + col
  return Math.max(0, Math.min(itemCount - 1, idx))
}

// ============================================================================
// Item — one render per data row; position fully driven by shared values
// ============================================================================

interface ItemProps<T extends DraggableItem> {
  item: T
  itemKey: string
  index: number
  cellW: number
  cellH: number
  columns: number
  columnGap: number
  rowGap: number
  renderItem: (info: RenderItemInfo<T>) => React.ReactNode

  // shared drag state
  activeKey: SharedValue<string | null>
  draggedFromIndex: SharedValue<number>
  draggedToIndex: SharedValue<number>
  dragX: SharedValue<number>
  dragY: SharedValue<number>
  // Drop-phase: from/to of the in-flight drop animation. While set, the
  // displaced item (at `dropToIndex`) animates to the from-slot in
  // parallel with the active item's slide to the to-slot.
  dropFromIndex: SharedValue<number>
  dropToIndex: SharedValue<number>

  // visual params
  activeItemScale: number
  activeItemOpacity: number
  inactiveItemScale: number
  inactiveItemOpacity: number
  activeItemShadowOpacity: number
  activationDur: number
  dropDur: number
  nudgeFraction: number
}

function ItemImpl<T extends DraggableItem>(props: ItemProps<T>) {
  const {
    item,
    itemKey,
    index,
    cellW,
    cellH,
    columns,
    columnGap,
    rowGap,
    renderItem,
    activeKey,
    draggedFromIndex,
    draggedToIndex,
    dragX,
    dragY,
    dropFromIndex,
    dropToIndex,
    activeItemScale,
    activeItemOpacity,
    inactiveItemScale,
    inactiveItemOpacity,
    activeItemShadowOpacity,
    activationDur,
    dropDur,
    nudgeFraction,
  } = props

  const baseCol = index % columns
  const baseRow = Math.floor(index / columns)
  const baseX = baseCol * cellW
  const baseY = baseRow * cellH

  const offsetX = useSharedValue(0)
  const offsetY = useSharedValue(0)
  const scale = useSharedValue(1)
  const opacity = useSharedValue(1)
  const shadow = useSharedValue(0)
  const zIndex = useSharedValue(0)

  useAnimatedReaction(
    () => ({
      key: activeKey.value,
      from: draggedFromIndex.value,
      to: draggedToIndex.value,
      dx: dragX.value,
      dy: dragY.value,
      dropFrom: dropFromIndex.value,
      dropTo: dropToIndex.value,
    }),
    (cur) => {
      const dragging = cur.key !== null && cur.from >= 0 && cur.to >= 0
      const dropping = cur.dropFrom >= 0 && cur.dropTo >= 0 && cur.dropFrom !== cur.dropTo

      // Active drag — follow finger.
      if (dragging && cur.key === itemKey) {
        offsetX.value = cur.dx
        offsetY.value = cur.dy
        scale.value = withTiming(activeItemScale, {duration: activationDur})
        opacity.value = withTiming(activeItemOpacity, {duration: activationDur})
        shadow.value = withTiming(activeItemShadowOpacity, {duration: activationDur})
        zIndex.value = 10
        return
      }

      // Drop phase — the dragger slides from its origin slot to the
      // destination slot. Driven by dropFromIndex/dropToIndex so it
      // works regardless of whether activeKey is still set.
      if (dropping && index === cur.dropFrom) {
        const toCol = cur.dropTo % columns
        const toRow = Math.floor(cur.dropTo / columns)
        const tx = (toCol - baseCol) * cellW
        const ty = (toRow - baseRow) * cellH
        offsetX.value = withTiming(tx, {duration: dropDur})
        offsetY.value = withTiming(ty, {duration: dropDur})
        scale.value = withTiming(1, {duration: dropDur})
        opacity.value = withTiming(1, {duration: dropDur})
        shadow.value = withTiming(0, {duration: dropDur})
        zIndex.value = 5
        return
      }

      // Displaced item — slides to the dragger's origin slot.
      if (dropping && index === cur.dropTo) {
        const fromCol = cur.dropFrom % columns
        const fromRow = Math.floor(cur.dropFrom / columns)
        const tx = (fromCol - baseCol) * cellW
        const ty = (fromRow - baseRow) * cellH
        offsetX.value = withTiming(tx, {duration: dropDur})
        offsetY.value = withTiming(ty, {duration: dropDur})
        scale.value = withTiming(1, {duration: dropDur})
        opacity.value = withTiming(1, {duration: dropDur})
        shadow.value = withTiming(0, {duration: dropDur})
        zIndex.value = 0
        return
      }

      // Drag phase nudge — only the item under the pointer nudges; the
      // actual swap happens on release.
      let tx = 0
      let ty = 0
      if (dragging && index === cur.to && index !== cur.from) {
        const fromCol = cur.from % columns
        const fromRow = Math.floor(cur.from / columns)
        tx = (fromCol - baseCol) * cellW
        ty = (fromRow - baseRow) * cellH
        const length = Math.sqrt(tx * tx + ty * ty)
        if (length > 0) {
          tx = (tx / length) * nudgeFraction
          ty = (ty / length) * nudgeFraction
        }
      }

      offsetX.value = withSpring(tx, {damping: 22, stiffness: 220, mass: 0.6})
      offsetY.value = withSpring(ty, {damping: 22, stiffness: 220, mass: 0.6})

      scale.value = withTiming(dragging ? inactiveItemScale : 1, {duration: activationDur})
      opacity.value = withTiming(dragging ? inactiveItemOpacity : 1, {duration: activationDur})
      shadow.value = withTiming(0, {duration: dropDur})
      if (!dragging && !dropping) zIndex.value = 0
    },
    [index, baseCol, baseRow, cellW, cellH, columns, nudgeFraction],
  )

  // When the data array reorders (parent commits the new order), this item's
  // index — and therefore baseX/baseY — change. Snap offsets to 0 so the
  // visible position matches the new slot. mountedRef avoids touching values
  // on first mount (the reaction is responsible for initial state).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    offsetX.value = 0
    offsetY.value = 0
    zIndex.value = 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: offsetX.value}, {translateY: offsetY.value}, {scale: scale.value}],
    opacity: opacity.value,
    shadowOpacity: shadow.value,
    zIndex: zIndex.value,
    elevation: zIndex.value,
  }))

  const innerStyle = useMemo<ViewStyle>(
    () => ({
      width: cellW - columnGap,
      height: cellH - rowGap,
      marginLeft: columnGap / 2,
      marginRight: columnGap / 2,
      marginTop: rowGap / 2,
      marginBottom: rowGap / 2,
    }),
    [cellW, cellH, columnGap, rowGap],
  )

  return (
    <Animated.View
      style={[
        styles.cell,
        {
          left: baseX,
          top: baseY,
          width: cellW,
          height: cellH,
          shadowColor: "#000",
          shadowOffset: {width: 0, height: 4},
          shadowRadius: 8,
        },
        animatedStyle,
      ]}>
      <View style={innerStyle}>{renderItem({item, index})}</View>
    </Animated.View>
  )
}

const Item = memo(ItemImpl) as typeof ItemImpl

// ============================================================================
// DraggableList
// ============================================================================

export function DraggableList<T extends DraggableItem>(props: DraggableListProps<T>) {
  const {
    data,
    renderItem,
    keyExtractor,
    sortEnabled = DEFAULTS.sortEnabled,
    columns = DEFAULTS.columns,
    rowGap = DEFAULTS.rowGap,
    columnGap = DEFAULTS.columnGap,
    dragActivationDelay = DEFAULTS.dragActivationDelay,
    activationAnimationDuration = DEFAULTS.activationAnimationDuration,
    dropAnimationDuration = DEFAULTS.dropAnimationDuration,
    overDrag = DEFAULTS.overDrag,
    activeItemScale = DEFAULTS.activeItemScale,
    activeItemOpacity = DEFAULTS.activeItemOpacity,
    activeItemShadowOpacity = DEFAULTS.activeItemShadowOpacity,
    inactiveItemOpacity = DEFAULTS.inactiveItemOpacity,
    inactiveItemScale = DEFAULTS.inactiveItemScale,
    onDragStart,
    onDragEnd,
    onOrderChange,
    onDragChange,
    contentContainerStyle,
    nudgeFraction = DEFAULTS.nudgeFraction,
    commitDelayMs = DEFAULTS.commitDelayMs,
  } = props

  const getKey = useCallback((it: T) => keyExtractor?.(it) ?? it.id, [keyExtractor])

  // Uniform cell height — take it from the first item.
  const cellH = data[0]?.height ?? 110

  const [containerWidth, setContainerWidth] = useState(0)
  const cellW = containerWidth > 0 ? containerWidth / columns : 0
  const rows = Math.ceil(data.length / columns)
  const totalHeight = rows * cellH

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width
    setContainerWidth((prev) => (prev === w ? prev : w))
  }, [])

  // Worklet-safe snapshot of keys + count so gestures don't call JS closures.
  const keysSV = useSharedValue<string[]>([])
  const itemCountSV = useSharedValue(0)
  useEffect(() => {
    const k: string[] = new Array(data.length)
    for (let i = 0; i < data.length; i++) k[i] = getKey(data[i])
    keysSV.value = k
    itemCountSV.value = data.length
  }, [data, getKey, keysSV, itemCountSV])

  // ---------- shared values ----------
  const activeKey = useSharedValue<string | null>(null)
  const draggedFromIndex = useSharedValue(-1)
  const draggedToIndex = useSharedValue(-1)
  const dragX = useSharedValue(0)
  const dragY = useSharedValue(0)
  const startX = useSharedValue(0)
  const startY = useSharedValue(0)
  const startBaseX = useSharedValue(0)
  const startBaseY = useSharedValue(0)
  const lastReportedToIndex = useSharedValue(-1)

  // Drop-phase indices — set on release, cleared at commit time.
  const dropFromIndex = useSharedValue(-1)
  const dropToIndex = useSharedValue(-1)

  // Latest data — read by handleDragEnd when it eventually commits.
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  // Pending commit timer — cancelled if the user picks up another drag
  // before the previous commit fires.
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingCommit = useCallback(() => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current)
      commitTimerRef.current = null
    }
  }, [])
  useEffect(() => () => cancelPendingCommit(), [cancelPendingCommit])

  // ---------- bridged callbacks ----------
  const handleDragStartJS = useCallback(
    (key: string, fromIndex: number) => {
      cancelPendingCommit()
      onDragStart?.({key, fromIndex})
    },
    [onDragStart, cancelPendingCommit],
  )

  const handleOrderChangeJS = useCallback(
    (key: string, fromIndex: number, toIndex: number) => {
      onOrderChange?.({key, fromIndex, toIndex})
    },
    [onOrderChange],
  )

  const handleDragChangeJS = useCallback(
    (key: string, x: number, y: number, index: number) => {
      onDragChange?.({key, x, y, index})
    },
    [onDragChange],
  )

  // Build the swapped array and notify the consumer. This is the *only*
  // place that mutates the visible order — we delay calling it until all
  // animations have settled, so the parent re-render doesn't interfere
  // with the drop animation.
  const commitOrderJS = useCallback(
    (key: string, fromIndex: number, toIndex: number) => {
      commitTimerRef.current = null
      // Clear all drag/drop state and snap drag offsets to 0 before the
      // data update lands. After the parent re-renders, each item's
      // useEffect on `index` resets its leftover offset to 0; combined
      // with the new baseX/baseY (from the new index) the visible
      // position matches what was on screen at end of animation.
      activeKey.value = null
      dragX.value = 0
      dragY.value = 0
      dropFromIndex.value = -1
      dropToIndex.value = -1
      const cur = dataRef.current
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= cur.length || toIndex >= cur.length) {
        onDragEnd?.({key, fromIndex, toIndex, data: cur})
        return
      }
      if (fromIndex === toIndex) {
        onDragEnd?.({key, fromIndex, toIndex, data: cur})
        return
      }
      const next = cur.slice()
      const a = next[fromIndex]
      next[fromIndex] = next[toIndex]
      next[toIndex] = a
      onDragEnd?.({key, fromIndex, toIndex, data: next})
    },
    [onDragEnd, activeKey, dragX, dragY, dropFromIndex, dropToIndex],
  )

  // Schedule commit after both items have finished animating into their
  // swapped slots, plus a grace period so the UI is fully at rest.
  const scheduleCommitJS = useCallback(
    (key: string, fromIndex: number, toIndex: number) => {
      cancelPendingCommit()
      const totalDelay = dropAnimationDuration + commitDelayMs
      commitTimerRef.current = setTimeout(() => {
        commitOrderJS(key, fromIndex, toIndex)
      }, totalDelay)
    },
    [cancelPendingCommit, commitOrderJS, dropAnimationDuration, commitDelayMs],
  )

  // ---------- gesture ----------
  const longPress = Gesture.LongPress()
    .minDuration(dragActivationDelay)
    .maxDistance(10)
    .enabled(sortEnabled)
    .onStart((e) => {
      "worklet"
      if (cellW <= 0 || cellH <= 0) return
      const localX = e.x
      const localY = e.y
      const col = Math.floor(localX / cellW)
      const row = Math.floor(localY / cellH)
      if (col < 0 || col >= columns || row < 0) return
      const idx = row * columns + col
      const count = itemCountSV.value
      if (idx < 0 || idx >= count) return
      const key = keysSV.value[idx]
      if (key === undefined) return

      activeKey.value = key
      draggedFromIndex.value = idx
      draggedToIndex.value = idx
      lastReportedToIndex.value = idx

      startX.value = localX
      startY.value = localY
      startBaseX.value = col * cellW
      startBaseY.value = row * cellH
      dragX.value = 0
      dragY.value = 0

      scheduleOnRN(handleDragStartJS, key, idx)
    })

  const pan = Gesture.Pan()
    .enabled(sortEnabled)
    .manualActivation(true)
    .onTouchesMove((_e, state) => {
      "worklet"
      if (activeKey.value !== null) state.activate()
    })
    .onUpdate((e) => {
      "worklet"
      if (activeKey.value === null || cellW <= 0) return

      const px = startBaseX.value + (e.x - startX.value) + cellW / 2
      const py = startBaseY.value + (e.y - startY.value) + cellH / 2

      let nx = e.x - startX.value
      let ny = e.y - startY.value
      if (overDrag === "horizontal" || overDrag === "none") {
        const minY = -startBaseY.value
        const maxY = totalHeight - cellH - startBaseY.value
        if (ny < minY) ny = minY
        if (ny > maxY) ny = maxY
      }
      if (overDrag === "vertical" || overDrag === "none") {
        const minX = -startBaseX.value
        const maxX = (columns - 1) * cellW - startBaseX.value
        if (nx < minX) nx = minX
        if (nx > maxX) nx = maxX
      }
      dragX.value = nx
      dragY.value = ny

      const newTo = locationToIndex(px, py, columns, cellW, cellH, itemCountSV.value)
      if (newTo !== draggedToIndex.value) {
        draggedToIndex.value = newTo
        if (newTo !== lastReportedToIndex.value) {
          lastReportedToIndex.value = newTo
          if (onOrderChange) {
            scheduleOnRN(handleOrderChangeJS, activeKey.value!, draggedFromIndex.value, newTo)
          }
        }
      }

      if (onDragChange) {
        scheduleOnRN(handleDragChangeJS, activeKey.value!, px, py, newTo)
      }
    })
    .onEnd(() => {
      "worklet"
      const key = activeKey.value
      const from = draggedFromIndex.value
      const to = draggedToIndex.value
      cancelAnimation(dragX)
      cancelAnimation(dragY)

      if (key === null) {
        console.log("key is null")
        return
      }

      // Set drop-phase indices — the Item reaction handles both the
      // active and displaced items' slides into their swapped slots.
      // Clear active/drag state immediately so the active item drops
      // out of the "follow finger" branch.
      if (from >= 0 && to >= 0 && from !== to) {
        dropFromIndex.value = from
        dropToIndex.value = to
      }
      activeKey.value = null
      draggedFromIndex.value = -1
      draggedToIndex.value = -1
      lastReportedToIndex.value = -1
      dragX.value = 0
      dragY.value = 0

      // Schedule the JS-side commit after the drop animation completes
      // (handled by setTimeout inside scheduleCommitJS).
      scheduleOnRN(scheduleCommitJS, key, from, to)
    })
    .onFinalize(() => {
      "worklet"
      if (activeKey.value !== null) {
        activeKey.value = null
        draggedFromIndex.value = -1
        draggedToIndex.value = -1
        lastReportedToIndex.value = -1
      }
    })

  const composed = Gesture.Simultaneous(longPress, pan)

  // ---------- render ----------
  return (
    <GestureDetector gesture={composed}>
      <View
        onLayout={onContainerLayout}
        style={[styles.container, {height: totalHeight}, contentContainerStyle]}>
        {containerWidth > 0 &&
          data.map((item, index) => {
            const k = getKey(item)
            return (
              <Item
                key={k}
                item={item}
                itemKey={k}
                index={index}
                cellW={cellW}
                cellH={cellH}
                columns={columns}
                columnGap={columnGap}
                rowGap={rowGap}
                renderItem={renderItem}
                activeKey={activeKey}
                draggedFromIndex={draggedFromIndex}
                draggedToIndex={draggedToIndex}
                dragX={dragX}
                dragY={dragY}
                dropFromIndex={dropFromIndex}
                dropToIndex={dropToIndex}
                activeItemScale={activeItemScale}
                activeItemOpacity={activeItemOpacity}
                inactiveItemScale={inactiveItemScale}
                inactiveItemOpacity={inactiveItemOpacity}
                activeItemShadowOpacity={activeItemShadowOpacity}
                activationDur={activationAnimationDuration}
                dropDur={dropAnimationDuration}
                nudgeFraction={nudgeFraction}
              />
            )
          })}
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    position: "relative",
  },
  cell: {
    position: "absolute",
  },
})

export default DraggableList
