import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {Dimensions, FlatList, Platform, Pressable, StyleSheet, TouchableOpacity, View} from "react-native"
import {DraggableMasonryList} from "react-native-draggable-masonry"
import {BlurView} from "expo-blur"

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
} from "@/stores/applets"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {SETTINGS, useSetting} from "@/stores/settings"
import {storage} from "@/utils/storage"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import GlassView from "@/components/ui/GlassView"

const GRID_COLUMNS = 4
const POPOVER_WIDTH = 180
const SCREEN_PADDING = 4 * 12

type MasonryAppItem = ClientAppletInterface & {id: string; height: number}

interface PopoverAction {
  label: string
  icon: string
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
  let popoverHeight = 8 + actions.length * 12 * 4
  popoverHeight += 0
  if (showAbove) {
    top = position.y - popoverHeight - 20
  }

  const popoverContent = (
    <View className="py-1">
      {actions.map((action, index) => (
        <View key={action.label}>
          <Pressable
            className="flex-row items-center gap-3 px-4 py-3 h-12 active:bg-foreground/10"
            onPress={() => {
              onClose()
              action.onPress()
            }}>
            <Icon
              name={action.icon as any}
              size={24}
              color={action.destructive ? theme.colors.destructive : theme.colors.foreground}
            />
            <Text
              className={`text-[15px] ${action.destructive ? "text-destructive" : "text-foreground"}`}
              text={action.label}
            />
          </Pressable>
          {index < actions.length - 1 && <View className="h-px bg-white/10 mx-4" />}
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

export function AppsGrid({showAllApps = false, onOpenApp, onAddToHome, searchQuery}: AppsGridProps) {
  const {themed, theme} = useAppTheme()

  const startApplet = useStartApplet()
  const [appSwitcherUi] = useSetting(SETTINGS.app_switcher_ui.key)
  const apps = useForegroundApps()

  const [orderMap, setOrderMap] = useState<OrderMap>({})
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition>({x: 0, y: 0, screenX: 0, screenY: 0})
  const [selectedApp, setSelectedApp] = useState<ClientAppletInterface | null>(null)
  const {push} = useNavigationHistory()

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

  const gridData: MasonryAppItem[] = useMemo(() => {
    let filteredApps = apps.filter((app) => {
      if (showAllApps) {
        // if (!app.compatibility?.isCompatible) {
        // return false
        // }
        return true
      }
      if (app.hidden && appSwitcherUi) {
        return false
      }
      if (app.running && !appSwitcherUi) {
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
    if (appSwitcherUi) {
      // console.log("MIN_APPS", MIN_APPS, "totalItems", totalItems)
      // console.log("emptySlots", emptySlots)
      // emptySlots = Math.max(emptySlots, MIN_APPS - totalItems)
      while (emptySlots + totalItems < MIN_APPS) {
        emptySlots += GRID_COLUMNS
      }
      if (emptySlots < GRID_COLUMNS) {
        emptySlots += GRID_COLUMNS
      }
    }
    // if (showAllApps) {
    //   emptySlots = 0
    // }

    if (!appSwitcherUi) {
      for (let i = 0; i < emptySlots; i++) {
        filteredApps.push({...DUMMY_APPLET, packageName: `@empty${totalItems + i}`})
      }
    }

    // Fill gaps in orderMap with dummy apps
    if (!showAllApps && appSwitcherUi) {
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

    if (appSwitcherUi) {
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
    } else {
      filteredApps.sort(sortAppsByPackageNamePriority)
    }

    if (showAllApps) {
      filteredApps.sort(sortAppsByPackageNamePriority)
    }

    return filteredApps.map((app) => ({
      ...app,
      id: app.packageName,
      height: 110,
    }))
  }, [apps, appSwitcherUi, orderMap, showAllApps, searchQuery])

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
        {
          label: translate("appInfo:open"),
          icon: "external-link",
          onPress: () => {
            if (liveSelectedApp) {
              startApplet(liveSelectedApp)
              if (onOpenApp) {
                onOpenApp?.(liveSelectedApp)
              }
            }
          },
        },
        !SYSTEM_APPS.includes(liveSelectedApp?.packageName || "") && {
          label: translate("appInfo:settings"),
          icon: "cog",
          onPress: () => {
            push("/applet/settings", {
              packageName: liveSelectedApp?.packageName,
              appName: liveSelectedApp?.name,
            })
          },
        },
        !showAllApps && {
          label: translate("appInfo:remove"),
          icon: "minus",
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
            icon: "home",
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
    [liveSelectedApp, startApplet, showAllApps],
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
            if (!appSwitcherUi) {
              return
            }
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
                textShadowColor: "rgba(0,0,0,0.3)",
                textShadowOffset: {width: 0, height: 1},
                textShadowRadius: 2,
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

  return (
    <View className="flex-1 mt-3">
      {!appSwitcherUi && (
        <View className="flex-row justify-between items-center pb-3">
          <Text tx="home:inactiveApps" className="font-semibold text-xl text-secondary-foreground" />
        </View>
      )}
      {!appSwitcherUi && (
        <FlatList
          data={gridData}
          renderItem={renderItem}
          keyExtractor={(item) => item.packageName}
          numColumns={GRID_COLUMNS}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
          contentContainerClassName="pb-4"
        />
      )}
      {appSwitcherUi && (
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
