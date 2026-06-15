import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Dimensions, FlatList, Platform, Pressable, StyleSheet, TouchableOpacity, View} from "react-native"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming} from "react-native-reanimated"
import {DraggableList} from "@/components/home/DraggableList"
import {BlurView} from "expo-blur"

import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {
  computeAppGrid,
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

const PlaceholderGrid: React.FC = () => {
  const pulse = useSharedValue(0.4)

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, {duration: 800, easing: Easing.inOut(Easing.ease)}), -1, true)
  }, [pulse])

  const animatedStyle = useAnimatedStyle(() => ({opacity: pulse.value}))

  return (
    <Animated.View className="flex-1 mt-3" style={animatedStyle}>
      <View className="flex-row flex-wrap">
        {Array.from({length: PLACEHOLDER_COUNT}).map((_, i) => (
          <View key={i} style={{width: `${100 / GRID_COLUMNS}%`}} className="items-center justify-center pt-3">
            <View className="w-16 h-16 rounded-2xl bg-foreground/10" />
            <View className="w-full h-9 my-1 items-center justify-start">
              <View className="w-12 h-3 mt-1 rounded bg-foreground/10" />
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
}

export function AppsGrid({
  showAllApps = false,
  onOpenApp,
  onAddToHome,
  searchQuery,
  showPlaceholders = false,
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
      // for (const [packageName, index] of Object.entries(result.value)) {
      //   console.log("index", index, "packageName", packageName)
      // }
      setOrderMap(result.value)
    }
  }, [])

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
    const {orderedApps, nextOrderMap} = computeAppGrid(
      {apps, orderMap, showAllApps, searchQuery},
      {dummyApplet: DUMMY_APPLET, sortByPriority: sortAppsByPackageNamePriority},
    )
    const data: MasonryAppItem[] = orderedApps.map((app) => ({...app, id: app.packageName, height: 110}))
    return {gridData: data, nextOrderMap}
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

  const dismissPopover = useCallback(() => {
    setPopoverVisible(false)
    setSelectedApp(null)
  }, [])

  const liveSelectedApp = useMemo(
    () => apps.find((a) => a.packageName === selectedApp?.packageName) ?? selectedApp,
    [apps, selectedApp],
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
        showAllApps &&
          liveSelectedApp?.hidden && {
            label: translate("appInfo:addToHome"),
            icon: "plus",
            onPress: () => {
              useAppStatusStore.getState().setHiddenStatus(liveSelectedApp?.packageName, false)
              if (onAddToHome) {
                onAddToHome(liveSelectedApp)
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
    [liveSelectedApp, startApplet, stopApplet, showAllApps],
  )

  const handlePress = async (app: ClientApp) => {
    if (app.packageName.includes("@empty")) return // ignore dummy apps
    const result = await askPermissionsUI(app, theme)
    if (result !== 1) return
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
          <AppIcon app={item} className="w-16 h-16" />
          <View className="w-full h-9 my-1 items-center justify-start">
            <Text
              className="text-foreground text-center mt-1 text-[12px] shrink"
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

  if (showPlaceholders) {
    return <PlaceholderGrid />
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
