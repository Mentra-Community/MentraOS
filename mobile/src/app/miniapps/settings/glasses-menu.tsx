import {useCallback, useEffect, useState} from "react"
import {Pressable, View} from "react-native"
import DraggableFlatList, {RenderItemParams} from "react-native-draggable-flatlist"
import {GestureHandlerRootView} from "react-native-gesture-handler"

import {Header, Icon, Screen, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {Group} from "@/components/ui"
import {RouteButton} from "@/components/ui/RouteButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n/translate"
import {sortAppsByLastOpenTime, useApps, type ClientApp} from "@mentra/island"

import {SYSTEM_APPS} from "@/constants/miniapps"
import {SETTINGS, useSetting} from "@/stores/settings"
import {buildMenuItems, filterCompatibleMenuItems, getDefaultMenuApps, type GlassesMenuItem} from "@/utils/glassesMenu"

const MAX_MENU_ITEMS = 10

export default function GlassesMenuScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const applets = useApps()
  const [savedMenuApps, setSavedMenuApps] = useSetting<GlassesMenuItem[] | null>(SETTINGS.menu_apps.key)
  const [menuItems, setMenuItems] = useState<GlassesMenuItem[]>([])
  const [showPicker, setShowPicker] = useState(false)
  const [sortedAvailable, setSortedAvailable] = useState<ClientApp[]>([])
  const [pickerReady, setPickerReady] = useState(false)

  // Load menu items on mount
  useEffect(() => {
    const load = async () => {
      if (savedMenuApps && savedMenuApps.length > 0) {
        const filtered = filterCompatibleMenuItems(savedMenuApps, applets)
        setMenuItems(filtered)
      } else {
        const defaults = await getDefaultMenuApps(applets)
        setMenuItems(defaults)
      }
    }
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const saveAndSync = useCallback(
    async (items: GlassesMenuItem[]) => {
      setMenuItems(items)
      await setSavedMenuApps(items)
    },
    [setSavedMenuApps],
  )

  const removeItem = useCallback(
    (packageName: string) => {
      setMenuItems((current) => {
        const updated = current.filter((item) => item.packageName !== packageName)
        setSavedMenuApps(updated)
        return updated
      })
    },
    [setSavedMenuApps],
  )

  const addItem = (app: {packageName: string; name: string}) => {
    if (menuItems.length >= MAX_MENU_ITEMS) return
    if (menuItems.some((item) => item.packageName === app.packageName)) return
    const newItems = buildMenuItems([...menuItems, {packageName: app.packageName, name: app.name}])
    saveAndSync(newItems)
    setShowPicker(false)
  }

  // Look up the full applet for a menu item (for icon rendering)
  const getApplet = (packageName: string): ClientApp | undefined => {
    return applets.find((a) => a.packageName === packageName)
  }

  // Apps available to add (compatible, not hidden, not system, not already in menu)
  const availableApps = applets.filter(
    (app) =>
      !app.hidden &&
      app.compatibility?.isCompatible !== false &&
      !SYSTEM_APPS.includes(app.packageName) &&
      !menuItems.some((item) => item.packageName === app.packageName),
  )

  // Sort available apps by most recent runtime when the picker opens
  useEffect(() => {
    if (!showPicker) {
      setPickerReady(false)
      return
    }
    let cancelled = false
    ;(async () => {
      const sorted = await sortAppsByLastOpenTime(availableApps)
      sorted.reverse() // most recent first
      if (!cancelled) {
        setSortedAvailable(sorted)
        setPickerReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showPicker, applets, menuItems]) // eslint-disable-line react-hooks/exhaustive-deps

  const renderMenuItem = useCallback(
    ({item, drag, isActive}: RenderItemParams<GlassesMenuItem>) => {
      const applet = getApplet(item.packageName)
      return (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: theme.spacing.s3,
            paddingHorizontal: theme.spacing.s4,
            backgroundColor: isActive ? theme.colors.border : "transparent",
            opacity: isActive ? 0.85 : 1,
          }}>
          <View style={{flexDirection: "row", alignItems: "center", gap: 12, flex: 1}}>
            <Pressable onLongPress={drag} delayLongPress={150} hitSlop={8} style={{padding: 4}}>
              <Icon name="grip-vertical" size={20} color={theme.colors.secondary_foreground} />
            </Pressable>
            {applet ? (
              <AppIcon app={applet} style={{width: 32, height: 32, borderRadius: 8}} disableLoader />
            ) : (
              <View style={{width: 32, height: 32, borderRadius: 8, backgroundColor: theme.colors.border}} />
            )}
            <Text style={{color: theme.colors.foreground}}>
              {item.name}
            </Text>
          </View>
          <Pressable onPress={() => removeItem(item.packageName)} hitSlop={8}>
            <Icon name="x" size={18} color={theme.colors.secondary_foreground} />
          </Pressable>
        </View>
      )
    },
    [applets, theme, removeItem], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const listHeader = (
    <View className="gap-6 pt-6 pb-2">
      <Text style={{color: theme.colors.secondary_foreground}} size="xs">
        {translate("settings:glassesMenuDescription")}
      </Text>
      <Text>{translate("settings:glassesMenuApps")}</Text>
    </View>
  )

  const listFooter = (
    <View className="gap-6 pt-6">
      {menuItems.length < MAX_MENU_ITEMS && (
        <Pressable
          onPress={() => setShowPicker(!showPicker)}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: theme.spacing.s3,
            paddingHorizontal: theme.spacing.s4,
          }}>
          <Icon name="plus" size={20} color={theme.colors.primary} />
          <Text style={{color: theme.colors.primary}}>
            {translate("settings:glassesMenuAddApp")}
          </Text>
        </Pressable>
      )}

      {showPicker && pickerReady && (
        <Group title={translate("settings:glassesMenuAvailableApps")}>
          {sortedAvailable.length === 0 && (
            <Text
              style={{
                color: theme.colors.secondary_foreground,
                padding: theme.spacing.s4,
              }}>
              {translate("settings:glassesMenuNoApps")}
            </Text>
          )}
          {sortedAvailable.map((app) => (
            <Pressable
              key={app.packageName}
              onPress={() => addItem(app)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: theme.spacing.s3,
                paddingHorizontal: theme.spacing.s4,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
              }}>
              <AppIcon app={app} style={{width: 28, height: 28, borderRadius: 6}} disableLoader />
              <Text style={{color: theme.colors.foreground}}>
                {app.name}
              </Text>
            </Pressable>
          ))}
        </Group>
      )}

      <RouteButton
        label={translate("settings:glassesMenuReset")}
        onPress={async () => {
          const defaults = await getDefaultMenuApps(applets)
          setMenuItems(defaults)
          await setSavedMenuApps(null)
        }}
      />
    </View>
  )

  const listEmpty = (
    <Text
      style={{
        color: theme.colors.secondary_foreground,
        padding: theme.spacing.s4,
      }}>
      {translate("settings:glassesMenuEmpty")}
    </Text>
  )

  return (
    <Screen preset="fixed">
      <Header titleTx="settings:glassesMenu" leftIcon="chevron-left" onLeftPress={goBack} />
      <GestureHandlerRootView style={{flex: 1}}>
        <DraggableFlatList
          data={menuItems}
          keyExtractor={(item) => item.packageName}
          renderItem={renderMenuItem}
          onDragEnd={({data}) => {
            setMenuItems(data)
            setSavedMenuApps(data)
          }}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          ListEmptyComponent={listEmpty}
          contentContainerStyle={{paddingBottom: theme.spacing.s6}}
          contentInsetAdjustmentBehavior="automatic"
        />
      </GestureHandlerRootView>
    </Screen>
  )
}
