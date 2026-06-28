import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Dimensions, FlatList, LayoutChangeEvent, Platform, Pressable, StyleSheet, TouchableOpacity, View} from "react-native"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming} from "react-native-reanimated"
import {warmCachedRemoteImageSources} from "@/hooks/useCachedRemoteImageSource"
import {DraggableList} from "@/components/home/DraggableList"
import {BlurView} from "expo-blur"

import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {
  DUMMY_APPLET,
  getAppsOrder,
  saveAppsOrder,
  sortAppsByPackageNamePriority,
  useAppStatusStore,
  useStart,
  useStop,
  type ClientApp,
  type OrderMap,
} from "@mentra/island"

import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {SYSTEM_APPS} from "@/constants/miniapps"
import {useForegroundApps} from "@/hooks/useAppsExtras"
import {uninstallAppUI} from "@/utils/uninstallAppUI"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {SETTINGS, useSetting} from "@/stores/settings"
import {storage} from "@/utils/storage"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import GlassView from "@/components/ui/GlassView"
import {DraggableMasonryList} from "react-native-draggable-masonry"

const GRID_COLUMNS = 4
const POPOVER_WIDTH = 180
const SCREEN_PADDING = 4 * 12
const PLACEHOLDER_COUNT = 20
const PRIMARY_HOME_SLOT_COUNT = PLACEHOLDER_COUNT
// Fixed height the masonry grid forces on every item. The skeleton uses the SAME
// value per cell so its rows line up exactly with the grid rows — this is the one
// source of truth for both (see gridData and PlaceholderGrid).
const GRID_ITEM_HEIGHT = 110
// Rows of the placeholder grid × item height. Used as a minHeight so the
// absolutely-filled skeleton cover lays out correctly before the grid underneath
// has measured.
const SKELETON_MIN_HEIGHT = Math.ceil(PLACEHOLDER_COUNT / GRID_COLUMNS) * GRID_ITEM_HEIGHT

type MasonryAppItem = ClientApp & {id: string; height: number}

interface PopoverAction {
  label: string
  icon: string
  iconSize?: number
  destructive?: boolean
  onPress: () => void
}

interface PopoverPosition {
  x: number
  y: number
  screenX: number
  screenY: number
}

const AppPopover: React.FC<{
  visible: boolean
  position: PopoverPosition
  actions: PopoverAction[]
  onClose: () => void
}> = ({visible, position, actions, onClose}) => {
  const {theme} = useAppTheme()
  const {width: screenWidth, height: screenHeight} = Dimensions.get("window")

  if (!visible) return null

  // const popoverHeight = actions.length * 44 + 16
  let left = position.x - POPOVER_WIDTH / 4
  let top = position.y + 120
  let xOffset = 0
  // let left = position.x - POPOVER_WIDTH / 2
  // let top = position.y
  // if (left < SCREEN_PADDING) left = SCREEN_PADDING
  if (left + POPOVER_WIDTH > screenWidth - SCREEN_PADDING) {
    let target = screenWidth - SCREEN_PADDING - POPOVER_WIDTH
    xOffset = target - left
  }
  left += xOffset

  if (left < 0) {
    xOffset = -left
    left = 0
  }

  let showAbove = false

  if (position.screenY > screenHeight / 2) {
    showAbove = true
  }

  // todo: find out the actual height of the popover via a ref:
  let popoverHeight = 8 + actions.length * 10 * 4
  popoverHeight += 0
  if (showAbove) {
    top = position.y - popoverHeight - 20
  }

  const popoverContent = (
    <View className="py-1">
      {actions.map((action, index) => (
        <View key={action.label}>
          <Pressable
            className="flex-row items-center gap-3 px-4 py-3 h-10 active:bg-foreground/10"
            onPress={() => {
              onClose()
              action.onPress()
            }}>
            <View className="w-5.5 justify-center items-center">
              <Icon
                name={action.icon as any}
                size={action.iconSize ?? 22}
                color={action.destructive ? theme.colors.destructive : theme.colors.foreground}
              />
            </View>
            <Text
              className={`text-[15px] leading-[15px] ${action.destructive ? "text-destructive" : "text-foreground"}`}
              text={action.label}
            />
          </Pressable>
          {index < actions.length - 1 && <View className="h-px bg-primary-foreground/90" />}
        </View>
      ))}
    </View>
  )

  let arrowLeft = 0
  let arrowTop = 0

  if (showAbove) {
    arrowTop = top + popoverHeight - 20
  } else {
    arrowTop = top - 10
  }
  arrowLeft = left + POPOVER_WIDTH / 2 - 20
  arrowLeft -= xOffset

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <View
          className="absolute"
          style={{
            left: left,
            top: top,
            width: POPOVER_WIDTH,
          }}>
          <GlassView className="rounded-2xl overflow-hidden bg-primary-foreground/95">{popoverContent}</GlassView>
        </View>
        <GlassView
          disableOnAndroid={true}
          className="absolute bg-primary-foreground/95 w-8 h-8 transform rotate-45 -z-1"
          style={{left: arrowLeft, top: arrowTop}}
        />
      </Pressable>
    </View>
  )
}

// `asCover` renders the skeleton for the absolutely-positioned cover in the gated
// path: it drops the top margin (the cover sits inside an already-mt-3 container,
// so its own mt-3 would push it 12px below the grid rows it's covering).
// `count` is how many skeleton cells to draw — pass the real gridData length so
// the skeleton matches the grid it's covering cell-for-cell.
const PlaceholderGrid: React.FC<{asCover?: boolean; count?: number}> = ({
  asCover = false,
  count = PLACEHOLDER_COUNT,
}) => {
  const pulse = useSharedValue(0.4)

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, {duration: 800, easing: Easing.inOut(Easing.ease)}), -1, true)
  }, [pulse])

  const animatedStyle = useAnimatedStyle(() => ({opacity: pulse.value}))

  return (
    <Animated.View className={`flex-1 ${asCover ? "" : "mt-3"}`} style={animatedStyle}>
      <View className="flex-row flex-wrap">
        {Array.from({length: count}).map((_, i) => (
          // Fixed GRID_ITEM_HEIGHT per cell + the SAME inner layout classes as the
          // real grid item (renderItem: "flex-1 items-center justify-center pt-3")
          // so skeleton rows line up exactly with the grid rows. The masonry forces
          // every item to this height; natural content height drifts row-by-row.
          <View key={i} style={{width: `${100 / GRID_COLUMNS}%`, height: GRID_ITEM_HEIGHT}}>
            <View className="flex-1 items-center justify-center pt-3">
              <View className="w-16 h-16 rounded-2xl bg-foreground/10" />
              <View className="w-full h-9 my-1 items-center justify-start">
                <View className="w-12 h-3 mt-1 rounded bg-foreground/10" />
              </View>
            </View>
          </View>
        ))}
      </View>
    </Animated.View>
  )
}

interface AppsGridProps {
  showAllApps?: boolean
  onOpenApp?: (app: ClientApp) => void
  onAddToHome?: (app: ClientApp) => void
  searchQuery?: string
  showPlaceholders?: boolean
  /**
   * Hold the skeleton up until every remote icon has been prefetched, then
   * reveal the whole grid at once (no blank gap, no per-icon stagger). Opt-in
   * because it trades a slightly later first paint for a cleaner reveal — used
   * by the all-apps sheet. The home grid leaves this off to paint immediately.
   */
  gateOnIconsReady?: boolean
}

export function AppsGrid({
  showAllApps = false,
  onOpenApp,
  onAddToHome,
  searchQuery,
  showPlaceholders = false,
  gateOnIconsReady = false,
}: AppsGridProps) {
  const {themed, theme} = useAppTheme()

  const startApplet = useStart()
  const stopApplet = useStop()
  const apps = useForegroundApps()

  const [orderMap, setOrderMap] = useState<OrderMap>({})
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({x: 0, y: 0, screenX: 0, screenY: 0})
  const [selectedApp, setSelectedApp] = useState<ClientApp | null>(null)
  const {push} = useNavigationStore.getState()

  const containerRef = useRef<View>(null)
  const isMovingRef = useRef(false)
  const draggingIndexRef = useRef(0)

  useEffect(() => {
    const result = getAppsOrder()
    if (result.is_ok()) {
      setOrderMap((current) => {
        const currentKeys = Object.keys(current)
        const nextKeys = Object.keys(result.value)
        if (currentKeys.length !== nextKeys.length) {
          return result.value
        }
        for (const key of nextKeys) {
          if (current[key] !== result.value[key]) {
            return result.value
          }
        }
        return current
      })
    }
  }, [apps])

  // gridData was previously a `useMemo` that MUTATED `orderMap` (React state)
  // during its computation — adding dummy `@emptyN` keys, deleting keys when
  // unpositioned real apps stole their slots, etc. Mutating state inside a
  // memo violates the pure-derivation contract: React assumes useMemo
  // produces the same output for the same deps, but a mutating memo
  // observes/changes its own input. In practice it caused unstable renders
  // and made the home screen jitter on Android because every refresh that
  // re-ran the memo perturbed `orderMap` and triggered downstream re-renders.
  //
  // Fix: work on a *local* copy inside the memo. After the memo returns,
  // a useEffect commits the new orderMap via setOrderMap only when it
  // actually changes. Same semantics, no mutation of React state during render.
  const {gridData, nextOrderMap} = useMemo(() => {
    let filteredApps = apps.filter((app) => {
      if (showAllApps) {
        return true
      }
      if (app.hidden) {
        return false
      }
      return true
    })

    // Apply search filter if searchQuery exists
    if (searchQuery && searchQuery.trim() !== "") {
      const query = searchQuery.toLowerCase().trim()
      filteredApps = filteredApps.filter(
        (app) => app.name?.toLowerCase().includes(query) || app.packageName?.toLowerCase().includes(query),
      )
    }

    // Local working copy — never mutate state during memo.
    const workingOrderMap: OrderMap = {...orderMap}

    // add dummy apps so we can place apps anywhere in the grid:
    const totalItems = filteredApps.length
    const remainder = totalItems % GRID_COLUMNS
    const MIN_APPS = 20
    let emptySlots = GRID_COLUMNS - remainder
    if (remainder == 0) {
      emptySlots = 0
    }
    while (emptySlots + totalItems < MIN_APPS) {
      emptySlots += GRID_COLUMNS
    }
    if (emptySlots < GRID_COLUMNS) {
      emptySlots += GRID_COLUMNS
    }

    // Fill gaps in workingOrderMap with dummy apps
    if (!showAllApps) {
      const orderedPackages = new Set(
        filteredApps.filter((app) => workingOrderMap[app.packageName] !== undefined).map((app) => app.packageName),
      )
      const usedIndices = new Set<number>()
      orderedPackages.forEach((pkg) => usedIndices.add(workingOrderMap[pkg]))

      if (usedIndices.size > 0) {
        const highestRealIndex = Math.max(...usedIndices)
        let maxIndex = filteredApps.length + emptySlots
        for (let i = 0; i <= highestRealIndex; i++) {
          if (!usedIndices.has(i)) {
            filteredApps.push({...DUMMY_APPLET, packageName: `@empty${i}`})
            workingOrderMap[`@empty${i}`] = i
            emptySlots -= 1
            maxIndex = filteredApps.length + emptySlots
          }
        }

        // add the remaining dummy apps:
        for (let i = highestRealIndex + 1; i <= maxIndex - 1; i++) {
          filteredApps.push({...DUMMY_APPLET, packageName: `@empty${i}`})
          workingOrderMap[`@empty${i}`] = i
          emptySlots -= 1
        }
      }
    }

    if (showAllApps) {
      emptySlots = Math.min(emptySlots, GRID_COLUMNS * 2)
      for (let i = 0; i < emptySlots; i++) {
        let index = filteredApps.length + i + 100
        filteredApps.push({...DUMMY_APPLET, packageName: `@empty${index}`})
        workingOrderMap[`@empty${index}`] = index
      }
    }

    // Assign unpositioned real apps to the first available empty slots
    const unpositioned = filteredApps.filter(
      (app) => !app.packageName.startsWith("@empty") && workingOrderMap[app.packageName] === undefined,
    )
    if (unpositioned.length > 0) {
      const dummySlots = filteredApps
        .filter((app) => app.packageName.startsWith("@empty") && workingOrderMap[app.packageName] !== undefined)
        .sort((a, b) => workingOrderMap[a.packageName] - workingOrderMap[b.packageName])

      for (const app of unpositioned) {
        const dummy = dummySlots.shift()
        if (dummy) {
          workingOrderMap[app.packageName] = workingOrderMap[dummy.packageName]
          delete workingOrderMap[dummy.packageName]
          const idx = filteredApps.indexOf(dummy)
          if (idx !== -1) filteredApps.splice(idx, 1)
        }
      }
    }

    filteredApps.sort((a, b) => {
      const aIndex = workingOrderMap[a.packageName]
      const bIndex = workingOrderMap[b.packageName]
      if (aIndex === undefined && bIndex === undefined) {
        return sortAppsByPackageNamePriority(a, b)
      }
      if (aIndex === undefined) return 1
      if (bIndex === undefined) return -1
      return aIndex - bIndex
    })

    if (showAllApps) {
      filteredApps.sort(sortAppsByPackageNamePriority)
    }

    const data: MasonryAppItem[] = filteredApps.map((app) => ({
      ...app,
      id: app.packageName,
      height: GRID_ITEM_HEIGHT,
    }))

    return {gridData: data, nextOrderMap: workingOrderMap}
  }, [apps, orderMap, showAllApps, searchQuery])

  // Commit the updated orderMap to state only when it actually differs from
  // the current one. Equality is shallow (key set + numeric values), which
  // matches how the memo above uses it. Without this guard we'd cause an
  // infinite render loop: setOrderMap → orderMap dep changes → memo re-runs
  // → potentially produces same nextOrderMap → setOrderMap called again.
  useEffect(() => {
    const prevKeys = Object.keys(orderMap)
    const nextKeys = Object.keys(nextOrderMap)
    if (prevKeys.length !== nextKeys.length) {
      setOrderMap(nextOrderMap)
      return
    }
    for (const k of nextKeys) {
      if (orderMap[k] !== nextOrderMap[k]) {
        setOrderMap(nextOrderMap)
        return
      }
    }
  }, [nextOrderMap, orderMap])

  // The remote icon URLs we need decoded before revealing the grid. Dummy
  // (@empty) slots, apps that render a React iconComponent, and non-remote
  // sources don't participate — they have nothing to fetch.
  const remoteIconUrls = useMemo(() => {
    const urls = new Set<string>()
    for (const app of gridData) {
      if (app.packageName.startsWith("@empty")) continue
      if (app.iconComponent) continue
      const url = app.logoUrl
      if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
        urls.add(url)
      }
    }
    return Array.from(urls)
  }, [gridData])

  // How many skeleton cells to draw: the real (non-dummy) apps, so skeleton boxes
  // only sit where actual icons will land — not over the grid's blank @empty
  // padding cells. Cheap: same array we already build.
  const skeletonCount = useMemo(
    () => gridData.filter((app) => !app.packageName.startsWith("@empty")).length,
    [gridData],
  )

  // Gate the FIRST grid reveal behind a single "all icons ready" flag so we go
  // straight from skeleton → fully-populated grid. Without this the placeholder
  // unmounts the moment the sheet opens (showPlaceholders flips), leaving a blank
  // frame while each AppIcon resolves its cache path independently and fades in at
  // staggered times. We prefetch every remote icon up front and only reveal once
  // they've all settled (resolved or failed), so they all appear at once.
  //
  // This only gates the initial reveal — once revealed we stay revealed, so
  // typing in search or reordering never drops the grid back to the skeleton.
  const [iconsReady, setIconsReady] = useState(!gateOnIconsReady)
  const iconUrlsKey = remoteIconUrls.join("\n")

  useEffect(() => {
    if (!gateOnIconsReady || iconsReady) return
    if (remoteIconUrls.length === 0) {
      setIconsReady(true)
      return
    }
    let cancelled = false
    // Warm the SAME resolved-path cache the icons read (useCachedRemoteImageSource),
    // not just expo-image's internal cache. Once warmed, every AppIcon resolves
    // its file:// path synchronously on first render — no post-mount async path
    // swap, so they paint together the instant the grid mounts.
    warmCachedRemoteImageSources(remoteIconUrls).then(() => {
      if (!cancelled) setIconsReady(true)
    })
    // Safety valve: never let a hung prefetch trap the grid behind the skeleton.
    // Reveal after a max wait regardless; any not-yet-cached icon just fades in
    // on its own (the rare slow case), which still beats a permanent skeleton.
    const fallback = setTimeout(() => {
      if (!cancelled) setIconsReady(true)
    }, 3000)
    return () => {
      cancelled = true
      clearTimeout(fallback)
    }
    // iconUrlsKey captures the URL set; remoteIconUrls identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconUrlsKey, iconsReady, gateOnIconsReady])

  // The masonry list renders empty until it measures its own width via onLayout
  // (item positions depend on containerWidth, which starts at 0), then needs a
  // frame to paint. So "grid mounted" != "grid visible" — revealing on mount alone
  // flashes an empty grid. The gated path below mounts the grid (so it measures)
  // under a skeleton cover, and only drops the cover once the grid has measured a
  // real height AND every icon's local path is warmed.
  //
  // Ready to reveal once the sheet is open and every icon's local path is warmed.
  const readyToReveal = !showPlaceholders && iconsReady
  const [gridPainted, setGridPainted] = useState(false)
  // Cover with the skeleton until we're ready AND the grid has actually measured
  // + painted. Before readyToReveal we always cover (even though the grid is
  // mounted underneath, measuring early).
  const skeletonOverlayVisible = gateOnIconsReady && !(readyToReveal && gridPainted)

  // Last measured height of the grid wrapper. The masonry mounts (and may fire
  // onLayout) while the sheet is still closed, so onLayout alone can't be the
  // trigger — by the time readyToReveal flips, the height won't change again and
  // no new onLayout fires. We record the height and reveal off whichever happens
  // last (layout or readiness).
  const gridWrapperHeightRef = useRef(0)

  const revealIfReady = useCallback(() => {
    if (!gateOnIconsReady) return
    if (readyToReveal && gridWrapperHeightRef.current > 1) {
      requestAnimationFrame(() => setGridPainted(true))
    }
  }, [gateOnIconsReady, readyToReveal])

  // Reset the painted flag whenever we leave the ready state, so a re-open
  // (sheet closed → opened again) re-covers until the grid re-measures.
  useEffect(() => {
    if (!readyToReveal) {
      setGridPainted(false)
    } else {
      // Readiness may flip AFTER the grid already measured — reveal now.
      revealIfReady()
    }
  }, [readyToReveal, revealIfReady])

  const handleGridWrapperLayout = useCallback(
    (e: LayoutChangeEvent) => {
      gridWrapperHeightRef.current = e.nativeEvent.layout.height
      revealIfReady()
    },
    [revealIfReady],
  )

  const dismissPopover = useCallback(() => {
    setPopoverVisible(false)
    setSelectedApp(null)
  }, [])

  const liveSelectedApp = useMemo(
    () => apps.find((a) => a.packageName === selectedApp?.packageName) ?? selectedApp,
    [apps, selectedApp],
  )

  const placeAppOnHome = useCallback(
    (app: ClientApp) => {
      const packageName = app.packageName
      useAppStatusStore.getState().setHiddenStatus(packageName, false)

      const latestOrder = getAppsOrder()
      const currentOrder = latestOrder.is_ok() ? latestOrder.value : orderMap
      const nextOrder: OrderMap = {...currentOrder}
      delete nextOrder[packageName]

      const emptySlot = Object.entries(nextOrder)
        .filter(([pkg, index]) => pkg.startsWith("@empty") && index < PRIMARY_HOME_SLOT_COUNT)
        .sort(([, a], [, b]) => a - b)[0]

      if (emptySlot) {
        const [emptyPackageName, emptyIndex] = emptySlot
        delete nextOrder[emptyPackageName]
        nextOrder[packageName] = emptyIndex
      } else {
        for (const [pkg, index] of Object.entries(nextOrder)) {
          nextOrder[pkg] = index + 1
        }
        nextOrder[packageName] = 0
      }

      setOrderMap(nextOrder)
      saveAppsOrder(nextOrder)
      onAddToHome?.(app)
    },
    [onAddToHome, orderMap],
  )

  const popoverActions: PopoverAction[] = useMemo(
    () =>
      [
        !liveSelectedApp?.running && {
          label: translate("appInfo:start"),
          icon: "play",
          onPress: () => {
            if (liveSelectedApp) {
              startApplet(liveSelectedApp, {skipNavigation: true})
              if (onOpenApp) {
                onOpenApp?.(liveSelectedApp)
              }
            }
          },
        },
        liveSelectedApp?.running && {
          label: translate("appInfo:stop"),
          icon: "pause",
          iconSize: 18,
          onPress: () => {
            if (liveSelectedApp) {
              stopApplet(liveSelectedApp.packageName)
            }
          },
        },
        !SYSTEM_APPS.includes(liveSelectedApp?.packageName || "") && {
          label: translate("appInfo:settings"),
          icon: "exclamation-circle",
          onPress: () => {
            push("/applet/settings", {
              packageName: liveSelectedApp?.packageName,
              appName: liveSelectedApp?.name,
            })
          },
        },
        !showAllApps && {
          label: translate("appInfo:remove"),
          icon: "circle-minus",
          onPress: () => {
            if (liveSelectedApp) {
              useAppStatusStore.getState().setHiddenStatus(liveSelectedApp.packageName, true)
              // useAppStatusStore.getState().refreshApplets()
            }
          },
        },
        showAllApps && {
          label: translate("appInfo:addToHome"),
          icon: "plus",
          onPress: () => {
            if (liveSelectedApp) {
              placeAppOnHome(liveSelectedApp)
            }
          },
        },
        !SYSTEM_APPS.includes(liveSelectedApp?.packageName || "") && {
          label: translate("appInfo:uninstall"),
          icon: "trash",
          destructive: true,
          onPress: () => {
            if (liveSelectedApp) {
              uninstallAppUI(liveSelectedApp)
            }
          },
        },
      ].filter(Boolean) as PopoverAction[],
    [liveSelectedApp, startApplet, stopApplet, showAllApps, placeAppOnHome, push, onOpenApp],
  )

  const handlePress = async (app: ClientApp) => {
    if (app.packageName.includes("@empty")) return // ignore dummy apps

    // Paint the splash the instant the user taps. Foregrounding synchronously
    // mounts the Compositor overlay (splash + open slide) BEFORE we do any async
    // work, so a tap is acknowledged immediately — instead of the old order
    // (await the permission check first), which left the user staring at the
    // home screen for the duration of the native permission round-trips and
    // made the splash feel like it "popped in" a second later.
    //
    // Only foreground-by-overlay app types benefit (local miniapps + offline-
    // hosted built-ins); other types navigate via routes inside startApplet, so
    // we leave their flow untouched and let startApplet drive it.
    const overlayForegrounded = app.local || isOfflineHosted(app.packageName)
    if (overlayForegrounded) {
      useAppStatusStore.getState().setForeground(app.packageName)
    }

    const result = await askPermissionsUI(app, theme)
    if (result !== 1) {
      // Permission denied / cancelled — tear the splash back down so we don't
      // leave an overlay up for an app we never actually launched.
      if (overlayForegrounded) {
        useAppStatusStore.getState().clearForeground()
      }
      return
    }
    startApplet(app)
    if (onOpenApp) {
      onOpenApp?.(app)
    }
  }

  const showPopover = useCallback(
    (key: string) => {
      const app = gridData.find((a) => a.packageName === key)
      // get the index of the app
      // const index = gridData.findIndex((a) => a.packageName === key)
      if (!app?.name) return

      const ref = itemRefs.current[app.packageName]
      setSelectedApp(app)

      // if (ref) {
      //   ref.measureInWindow((x, y, width, height) => {
      //     setPopoverPosition({
      //       x: x + width / 2,
      //       y: y + height + 8,
      //     })
      //     setPopoverVisible(true)
      //   })
      // } else {
      //   const {width} = Dimensions.get("window")
      //   setPopoverPosition({x: width / 2, y: 300})
      //   setPopoverVisible(true)
      // }

      if (!ref) {
        // fallback to 0, 0
        let left = 0
        let top = 0
        setPopoverPosition({x: left, y: top, screenX: left, screenY: 0})
        setPopoverVisible(true)
        return
      }

      ref.measureLayout(
        containerRef.current as any,
        (x, y, _cWidth, _cHeight) => {
          // console.log("x", x, "y", y, "width", width, "height", height)
          ref.measureInWindow((screenX, screenY, _width, _height) => {
            setPopoverPosition({x, y, screenX, screenY})
            setPopoverVisible(true)
          })
        },
        () => console.warn("measureLayout failed"),
      )
    },
    [gridData],
  )

  const handleDragStart = ({key}: {key: string; fromIndex: number}) => {
    isMovingRef.current = false
    showPopover(key)
  }

  const handleDragChange = ({key, x, y, index}: {key: string; x: number; y: number; index: number}) => {
    if (!isMovingRef.current) {
      isMovingRef.current = true
      draggingIndexRef.current = index
    }

    if (isMovingRef.current && draggingIndexRef.current !== index) {
      dismissPopover()
    }
  }

  const handleDragEnd = ({data}: {data: MasonryAppItem[]}) => {
    isMovingRef.current = false

    const newOrderMap: OrderMap = {}
    data.forEach((item, index) => {
      newOrderMap[item.packageName] = index
    })
    setOrderMap(newOrderMap)
    saveAppsOrder(newOrderMap)
  }

  const itemRefs = useRef<Record<string, View | null>>({})

  const renderItem = useCallback(
    ({item}: {item: MasonryAppItem}) => {
      return (
        <TouchableOpacity
          ref={(ref) => {
            itemRefs.current[item.packageName] = ref
          }}
          className="flex-1 items-center justify-center pt-3"
          onPress={() => {
            // if (showAllApps) {
            //   showPopover(item.packageName)
            //   return
            // }
            handlePress(item)
          }}
          onLongPress={() => {
            if (showAllApps) {
              showPopover(item.packageName)
              return
            }
          }}
          activeOpacity={0.7}>
          <AppIcon app={item} className="w-16 h-16" instant />
          <View className="w-full h-9 my-1 items-center justify-start">
            <Text
              className={`text-foreground text-center mt-1 text-[12px] shrink ${
                item.compatibility?.isCompatible ? "" : "opacity-20"
              }`}
              style={{
                textShadowColor: "rgba(0,0,0,0.08)",
                textShadowOffset: {width: 0, height: 0},
                textShadowRadius: 30,
              }}
              numberOfLines={2}
              ellipsizeMode="tail"
              text={item.name}
            />
          </View>
        </TouchableOpacity>
      )
    },
    [themed, theme, startApplet],
  )

  // Non-gated path (home grid): unchanged — plain skeleton while showPlaceholders,
  // then grid. (readyToReveal === !showPlaceholders here since iconsReady is true.)
  if (!gateOnIconsReady) {
    if (!readyToReveal) {
      return <PlaceholderGrid count={skeletonCount || PLACEHOLDER_COUNT} />
    }
    return (
      <View className="flex-1 mt-3">
        <View ref={containerRef}>
          <DraggableMasonryList
            data={gridData}
            renderItem={renderItem}
            rowGap={0}
            columnGap={0}
            columns={GRID_COLUMNS}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragChange={handleDragChange}
            overDrag="none"
            showDropIndicator={false}
            sortEnabled={!showAllApps}
            swapMode={true}
            dropIndicatorStyle={{backgroundColor: theme.colors.primary_foreground, borderWidth: 0}}
          />
        </View>
        <AppPopover
          visible={popoverVisible}
          position={popoverPosition}
          actions={popoverActions}
          onClose={dismissPopover}
        />
      </View>
    )
  }

  // Gated path (all-apps sheet): the masonry grid renders empty until it measures
  // its width (onLayout) and paints, so revealing on mount flashes an empty grid.
  // We mount the grid IN NORMAL FLOW (so it measures, scrolls, and drives the
  // sheet's content height) but keep it invisible (opacity 0) under a skeleton
  // cover. The cover is the same skeleton, absolutely filling the container; a
  // minHeight keeps it laid out correctly before the grid has any measured height
  // (otherwise the absolute child collapses). Once the grid wrapper reports a real
  // measured height we fade to the grid — skeleton → filled icons, no empty flash,
  // no second skeleton, no layout jump.
  const covering = skeletonOverlayVisible
  return (
    <View className="flex-1 mt-3" style={covering ? {minHeight: SKELETON_MIN_HEIGHT} : undefined}>
      <View ref={containerRef} onLayout={handleGridWrapperLayout} style={{opacity: covering ? 0 : 1}}>
        <DraggableMasonryList
          data={gridData}
          renderItem={renderItem}
          rowGap={0}
          columnGap={0}
          columns={GRID_COLUMNS}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragChange={handleDragChange}
          overDrag="none"
          showDropIndicator={false}
          sortEnabled={!showAllApps}
          swapMode={true}
          dropIndicatorStyle={{backgroundColor: theme.colors.primary_foreground, borderWidth: 0}}
        />
      </View>
      {covering && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <PlaceholderGrid asCover count={skeletonCount || PLACEHOLDER_COUNT} />
        </View>
      )}
      <AppPopover
        visible={popoverVisible}
        position={popoverPosition}
        actions={popoverActions}
        onClose={dismissPopover}
      />
    </View>
  )
}
