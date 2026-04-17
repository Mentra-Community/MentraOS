import {useCallback, useEffect, useState} from "react"
import {Pressable, ScrollView, View} from "react-native"
import DraggableFlatList, {RenderItemParams, ScaleDecorator} from "react-native-draggable-flatlist"
import {GestureHandlerRootView} from "react-native-gesture-handler"

import {Header, Icon, Screen, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {Group} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {SYSTEM_APPS, useApplets, type ClientAppletInterface} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"
import {
  buildMenuItems,
  filterCompatibleMenuItems,
  getDefaultMenuApps,
  syncDashboardMenu,
  type GlassesMenuItem,
} from "@/utils/glassesMenu"

const MAX_MENU_ITEMS = 10

export default function GlassesMenuScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const applets = useApplets()
  const [savedMenuApps, setSavedMenuApps] = useSetting<GlassesMenuItem[] | null>(SETTINGS.glasses_menu_apps.key)
  const [menuItems, setMenuItems] = useState<GlassesMenuItem[]>([])
  const [showPicker, setShowPicker] = useState(false)

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

  const saveAndSync = async (items: GlassesMenuItem[]) => {
    setMenuItems(items)
    await setSavedMenuApps(items)
    await syncDashboardMenu()
  }

  const removeItem = (packageName: string) => {
    const updated = menuItems.filter((item) => item.packageName !== packageName)
    saveAndSync(updated)
  }

  const addItem = (app: {packageName: string; name: string}) => {
    if (menuItems.length >= MAX_MENU_ITEMS) return
    if (menuItems.some((item) => item.packageName === app.packageName)) return
    const newItems = buildMenuItems([...menuItems, {packageName: app.packageName, name: app.name}])
    saveAndSync(newItems)
    setShowPicker(false)
  }

  // Look up the full applet for a menu item (for icon rendering)
  const getApplet = (packageName: string): ClientAppletInterface | undefined => {
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

  // Incompatible apps (shown disabled, excluding system apps)
  const incompatibleApps = applets.filter(
    (app) => !app.hidden && app.compatibility?.isCompatible === false && !SYSTEM_APPS.includes(app.packageName),
  )

  const renderMenuItem = useCallback(
    ({item, drag, isActive}: RenderItemParams<GlassesMenuItem>) => {
      const applet = getApplet(item.packageName)
      return (
        <ScaleDecorator>
          <Pressable
            onLongPress={drag}
            disabled={isActive}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingVertical: theme.spacing.s3,
              paddingHorizontal: theme.spacing.s4,
            }}>
            <View style={{flexDirection: "row", alignItems: "center", gap: 12, flex: 1}}>
              {applet ? (
                <AppIcon app={applet} style={{width: 32, height: 32, borderRadius: 8}} disableLoader />
              ) : (
                <View style={{width: 32, height: 32, borderRadius: 8, backgroundColor: theme.colors.border}} />
              )}
              <Text style={{color: theme.colors.foreground}} size="sm">
                {item.name}
              </Text>
            </View>
            <Pressable onPress={() => removeItem(item.packageName)} hitSlop={8}>
              <Icon name="x" size={18} color={theme.colors.secondary_foreground} />
            </Pressable>
          </Pressable>
        </ScaleDecorator>
      )
    },
    [applets, theme], // eslint-disable-line react-hooks/exhaustive-deps
  )

  return (
    <Screen preset="fixed">
      <Header titleTx="settings:glassesMenu" leftIcon="chevron-left" onLeftPress={goBack} />
      <GestureHandlerRootView style={{flex: 1}}>
        <ScrollView
          style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}
          contentInsetAdjustmentBehavior="automatic">
          <View className="gap-6 pt-6">
            <Text style={{color: theme.colors.secondary_foreground}} size="xs">
              {translate("settings:glassesMenuDescription")}
            </Text>

            {/* Current menu items — draggable list */}
            <Group title={translate("settings:glassesMenuApps")}>
              {menuItems.length === 0 ? (
                <Text
                  style={{
                    color: theme.colors.secondary_foreground,
                    padding: theme.spacing.s4,
                  }}>
                  {translate("settings:glassesMenuEmpty")}
                </Text>
              ) : (
                <DraggableFlatList
                  data={menuItems}
                  keyExtractor={(item) => item.packageName}
                  renderItem={renderMenuItem}
                  onDragEnd={({data}) => saveAndSync(data)}
                  scrollEnabled={false}
                />
              )}
            </Group>

            {/* Add app button */}
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
                <Text style={{color: theme.colors.primary}} size="sm">
                  {translate("settings:glassesMenuAddApp")}
                </Text>
              </Pressable>
            )}

            {/* App picker */}
            {showPicker && (
              <Group title={translate("settings:glassesMenuAvailableApps")}>
                {availableApps.length === 0 && incompatibleApps.length === 0 && (
                  <Text
                    style={{
                      color: theme.colors.secondary_foreground,
                      padding: theme.spacing.s4,
                    }}>
                    {translate("settings:glassesMenuNoApps")}
                  </Text>
                )}
                {availableApps.map((app) => (
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
                    <Text style={{color: theme.colors.foreground}} size="sm">
                      {app.name}
                    </Text>
                  </Pressable>
                ))}
                {/* Incompatible apps shown greyed out */}
                {incompatibleApps.map((app) => (
                  <View
                    key={app.packageName}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingVertical: theme.spacing.s3,
                      paddingHorizontal: theme.spacing.s4,
                      borderBottomWidth: 1,
                      borderBottomColor: theme.colors.border,
                      opacity: 0.4,
                    }}>
                    <AppIcon app={app} style={{width: 28, height: 28, borderRadius: 6}} disableLoader />
                    <Text style={{color: theme.colors.secondary_foreground}} size="sm">
                      {app.name} {translate("settings:glassesMenuIncompatible")}
                    </Text>
                  </View>
                ))}
              </Group>
            )}

            {/* Reset to auto */}
            <Pressable
              onPress={async () => {
                const defaults = await getDefaultMenuApps(applets)
                setMenuItems(defaults)
                await setSavedMenuApps(null)
                await syncDashboardMenu()
              }}
              style={{
                paddingVertical: theme.spacing.s3,
                paddingHorizontal: theme.spacing.s4,
              }}>
              <Text style={{color: theme.colors.secondary_foreground}} size="xs">
                {translate("settings:glassesMenuReset")}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </GestureHandlerRootView>
    </Screen>
  )
}
