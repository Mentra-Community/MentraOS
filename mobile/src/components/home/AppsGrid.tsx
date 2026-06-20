import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Dimensions, FlatList, Platform, Pressable, StyleSheet, TouchableOpacity, View} from "react-native"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming} from "react-native-reanimated"
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
  useSetForeground,
  useStart,
  useStop,
  HardwareType,
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
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {showAlert} from "@/contexts/ModalContext"
import {DraggableMasonryList} from "react-native-draggable-masonry"

const GRID_COLUMNS = 4
const POPOVER_WIDTH = 180
const SCREEN_PADDING = 4 * 12
const PLACEHOLDER_COUNT = 20
const PRIMARY_HOME_SLOT_COUNT = PLACEHOLDER_COUNT

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

async function showCompatibilityAlert(app: ClientApp): Promise<boolean> {
  if (app.compatibility?.isCompatible !== false) {
    return false
  }

  const missingTypes = app.compatibility.missingRequired?.map((req) => req.type) ?? []
  if (missingTypes.includes(HardwareType.EXIST)) {
    await showAlert({
      title: translate("home:glassesRequired"),
      buttons: [{text: translate("common:ok")}],
      message: translate("home:glassesRequiredMessage", {app: app.name}),
    })
    return true
  }

  const missingHardware =
    missingTypes
      .filter((type) => type !== HardwareType.EXIST)
      .map((type) => type.toLowerCase())
      .join(", ") || translate("home:requiredFeatures")

  await showAlert({
    title: translate("home:hardwareIncompatible"),
    buttons: [{text: translate("common:ok")}],
    message: translate("home:hardwareIncompatibleMessage", {app: app.name, missing: missingHardware}),
  })
  return true
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
  const setForeground = useSetForeground()
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
      height: 110,
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

  const dismissPopover = useCallback(() => {
    setPopoverVisible(false)
    setSelectedApp(null)
  }, [])

  const liveSelectedApp = useMemo(
    () => apps.find((a) => a.packageName === selectedApp?.packageName) ?? selectedApp,
    [apps, selectedApp],
  )

  const openApp = useCallback(
    async (app: ClientApp) => {
      if (await showCompatibilityAlert(app)) return

      const started = app.running || (await startApplet(app, {skipNavigation: true}))
      if (!started) return

      if (isOfflineHosted(app.packageName) || app.local) {
        await setForeground(app.packageName)
      } else if (app.offlineRoute) {
        push(app.offlineRoute, {transition: "fade"})
      } else if (app.webviewUrl && app.healthy) {
        push("/applet/webview", {
          webviewURL: app.webviewUrl,
          appName: app.name,
          packageName: app.packageName,
          transition: "fade",
        })
      }

      onOpenApp?.(app)
    },
    [onOpenApp, push, setForeground, startApplet],
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
              void openApp(liveSelectedApp)
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
    [liveSelectedApp, openApp, stopApplet, showAllApps, placeAppOnHome, push],
  )

  const handlePress = useCallback(async (app: ClientApp) => {
    if (app.packageName.includes("@empty")) return // ignore dummy apps
    if (await showCompatibilityAlert(app)) return

    const result = await askPermissionsUI(app, theme)
    if (result !== 1) return
    await openApp(app)
  }, [openApp, theme])

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
    [handlePress, showAllApps, showPopover],
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
