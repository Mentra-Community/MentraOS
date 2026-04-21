import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Dimensions, Pressable, StyleSheet, TouchableOpacity, View} from "react-native"
import {DraggableMasonryList} from "react-native-draggable-masonry"

import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {
  ClientAppletInterface,
  DUMMY_APPLET,
  getAppsOrder,
  OrderMap,
  saveAppsOrder,
  sortAppsByPackageNamePriority,
  SYSTEM_APPS,
  uninstallAppUI,
  useAppletStatusStore,
  useForegroundApps,
  useStartApplet,
  useStopApplet,
} from "@/stores/applets"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import GlassView from "@/components/ui/GlassView"
import Animated, {
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  SharedValue,
} from "react-native-reanimated"
import {BackgroundTimer} from "@/utils/timers"

const GRID_COLUMNS = 4
const POPOVER_WIDTH = 180
const SCREEN_PADDING = 4 * 12

type MasonryAppItem = ClientAppletInterface & {id: string; height: number}

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
              className={`text-[15px] ${action.destructive ? "text-destructive" : "text-foreground"}`}
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
          className="absolute bg-primary-foreground/95 w-8 h-8 transform rotate-45 -z-1"
          style={{left: arrowLeft, top: arrowTop}}
        />
      </Pressable>
    </View>
  )
}

interface AppsGridProps {
  showAllApps?: boolean
  onOpenApp?: (app: ClientAppletInterface) => void
  onAddToHome?: (app: ClientAppletInterface) => void
  searchQuery?: string
}

const WiggleWrapper: React.FC<{
  enabled: SharedValue<boolean>
  isDummy: boolean
  children: React.ReactNode
}> = ({enabled, isDummy, children}) => {
  const offset = useSharedValue(0)
  const randomPhase = useRef(Math.random() * 120).current

  // React to `enabled` flipping instead of polling it 10×/sec. With 50+ icons,
  // a per-icon setInterval pegged the JS thread enough to heat the device on
  // an idle home screen.
  useAnimatedReaction(
    () => enabled.value,
    (isEnabled, wasEnabled) => {
      "worklet"
      if (isEnabled === wasEnabled) return
      if (isEnabled && !isDummy) {
        offset.value = withRepeat(
          withSequence(
            withTiming(1, {duration: 60 + randomPhase}),
            withTiming(-1, {duration: 120}),
            withTiming(0, {duration: 60 + randomPhase}),
          ),
          -1,
        )
      } else {
        cancelAnimation(offset)
        offset.value = withTiming(0, {duration: 100})
      }
    },
    [isDummy],
  )

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{rotate: `${offset.value * 2}deg`}],
  }))

  return (
    <Animated.View style={animatedStyle} className="items-center">
      {children}
    </Animated.View>
  )
}

export function AppsGrid({showAllApps = false, onOpenApp, onAddToHome, searchQuery}: AppsGridProps) {
  const {themed, theme} = useAppTheme()

  const startApplet = useStartApplet()
  const stopApplet = useStopApplet()
  const apps = useForegroundApps()

  const [orderMap, setOrderMap] = useState<OrderMap>({})
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({x: 0, y: 0, screenX: 0, screenY: 0})
  const [selectedApp, setSelectedApp] = useState<ClientAppletInterface | null>(null)
  const {push} = useNavigationHistory()

  const containerRef = useRef<View>(null)
  const isMovingRef = useRef(false)
  const draggingIndexRef = useRef(0)
  const wiggleEnabled = useSharedValue(false)
  const wiggleTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    const result = getAppsOrder()
    if (result.is_ok()) {
      // for (const [packageName, index] of Object.entries(result.value)) {
      //   console.log("index", index, "packageName", packageName)
      // }
      setOrderMap(result.value)
    }
  }, [])

  const gridData: MasonryAppItem[] = useMemo(() => {
    let filteredApps = apps.filter((app) => {
      if (showAllApps) {
        // if (!app.compatibility?.isCompatible) {
        // return false
        // }
        return true
      }
      if (app.hidden) {
        return false
      }
      // if (!app.compatibility?.isCompatible) {
      //   return false
      // }
      return true
    })

    // Apply search filter if searchQuery exists
    if (searchQuery && searchQuery.trim() !== "") {
      const query = searchQuery.toLowerCase().trim()
      filteredApps = filteredApps.filter(
        (app) => app.name?.toLowerCase().includes(query) || app.packageName?.toLowerCase().includes(query),
      )
    }

    // add dummy apps so we can place apps anywhere in the grid:
    const totalItems = filteredApps.length
    const remainder = totalItems % GRID_COLUMNS
    const MIN_APPS = 20
    let emptySlots = GRID_COLUMNS - remainder
    if (remainder == 0) {
      emptySlots = 0
    }
    // console.log("MIN_APPS", MIN_APPS, "totalItems", totalItems)
    // console.log("emptySlots", emptySlots)
    // emptySlots = Math.max(emptySlots, MIN_APPS - totalItems)
    while (emptySlots + totalItems < MIN_APPS) {
      emptySlots += GRID_COLUMNS
    }
    if (emptySlots < GRID_COLUMNS) {
      emptySlots += GRID_COLUMNS
    }

    // if (showAllApps) {
    //   emptySlots = 0
    // }

    // Fill gaps in orderMap with dummy apps
    if (!showAllApps) {
      const orderedPackages = new Set(
        filteredApps.filter((app) => orderMap[app.packageName] !== undefined).map((app) => app.packageName),
      )
      const usedIndices = new Set<number>()
      orderedPackages.forEach((pkg) => usedIndices.add(orderMap[pkg]))

      if (usedIndices.size > 0) {
        const highestRealIndex = Math.max(...usedIndices)
        let maxIndex = filteredApps.length + emptySlots
        // console.log("maxIndex", maxIndex)
        for (let i = 0; i <= highestRealIndex; i++) {
          if (!usedIndices.has(i)) {
            // console.log(`adding dummy app @empty${i}`)
            filteredApps.push({...DUMMY_APPLET, packageName: `@empty${i}`})
            orderMap[`@empty${i}`] = i
            emptySlots -= 1
            maxIndex = filteredApps.length + emptySlots
          }
        }

        // add the remaining dummy apps:
        for (let i = highestRealIndex + 1; i <= maxIndex - 1; i++) {
          // console.log(`adding dummy app @empty${i}`)
          filteredApps.push({...DUMMY_APPLET, packageName: `@empty${i}`})
          // Add the gap dummy to the orderMap so it sorts correctly
          orderMap[`@empty${i}`] = i
          emptySlots -= 1
        }
      }
    }

    if (showAllApps) {
      // console.log("adding empty slots", emptySlots)
      emptySlots = Math.min(emptySlots, GRID_COLUMNS * 2)
      for (let i = 0; i < emptySlots; i++) {
        let index = filteredApps.length + i + 100
        filteredApps.push({...DUMMY_APPLET, packageName: `@empty${index}`})
        orderMap[`@empty${index}`] = index
      }
    }

    // Assign unpositioned real apps to the first available empty slots
    const unpositioned = filteredApps.filter(
      (app) => !app.packageName.startsWith("@empty") && orderMap[app.packageName] === undefined,
    )
    if (unpositioned.length > 0) {
      const dummySlots = filteredApps
        .filter((app) => app.packageName.startsWith("@empty") && orderMap[app.packageName] !== undefined)
        .sort((a, b) => orderMap[a.packageName] - orderMap[b.packageName])

      for (const app of unpositioned) {
        const dummy = dummySlots.shift()
        if (dummy) {
          orderMap[app.packageName] = orderMap[dummy.packageName]
          delete orderMap[dummy.packageName]
          const idx = filteredApps.indexOf(dummy)
          if (idx !== -1) filteredApps.splice(idx, 1)
        }
      }
    }

    filteredApps.sort((a, b) => {
      const aIndex = orderMap[a.packageName]
      const bIndex = orderMap[b.packageName]
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

    return filteredApps.map((app) => ({
      ...app,
      id: app.packageName,
      height: 110,
    }))
  }, [apps, orderMap, showAllApps, searchQuery])

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
              useAppletStatusStore.getState().setHiddenStatus(liveSelectedApp.packageName, true)
              // useAppletStatusStore.getState().refreshApplets()
            }
          },
        },
        showAllApps &&
          liveSelectedApp?.hidden && {
            label: translate("appInfo:addToHome"),
            icon: "plus",
            onPress: () => {
              useAppletStatusStore.getState().setHiddenStatus(liveSelectedApp?.packageName, false)
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

  const handlePress = async (app: ClientAppletInterface) => {
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
    [gridData, handlePress],
  )

  const handleDragStart = useCallback(
    ({key}: {key: string; fromIndex: number}) => {
      isMovingRef.current = false
      showPopover(key)
      wiggleTimeoutRef.current = BackgroundTimer.setTimeout(() => {
        wiggleEnabled.value = true
      }, 500)
    },
    [showPopover],
  )

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
    // stop wiggle:
    wiggleEnabled.value = false
    if (wiggleTimeoutRef.current) {
      BackgroundTimer.clearTimeout(wiggleTimeoutRef.current)
      wiggleTimeoutRef.current = null
    }
    // save the new order:
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
      const isDummy = item.packageName.startsWith("@empty")
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
          <WiggleWrapper enabled={wiggleEnabled} isDummy={isDummy}>
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
          </WiggleWrapper>
        </TouchableOpacity>
      )
    },
    [themed, theme, startApplet, wiggleEnabled, handlePress, showAllApps],
  )
  
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
