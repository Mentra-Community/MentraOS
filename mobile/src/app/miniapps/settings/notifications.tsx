import {useState, useEffect, useCallback, useMemo, useRef} from "react"
import {View, Platform, TextInput, FlatList, ActivityIndicator, Image, ScrollView} from "react-native"
import Toast from "react-native-toast-message"

import NativeNotificationSettings from "@/components/settings/NativeNotificationSettings"
import {Screen, Text, Header, Switch} from "@/components/ignite"
import {PillButton} from "@/components/ignite/PillButton"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {notifyPackageName} from "@/constants/miniapps"
import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {useRegisterCapsule} from "@/stores/capsule"
import {setPackagesBlocked} from "@/utils/notificationBlocklist"

interface InstalledApp {
  packageName: string
  appName: string
  icon: string | null
}

interface AppRow extends InstalledApp {
  isBlocked: boolean
}

// Fixed item height for consistent scrolling
const ITEM_HEIGHT = 64

export default function NotificationSettingsScreen() {
  const {theme} = useAppTheme()
  const viewShotRef = useRef<View>(null)

  // Render the global capsule (minimize / close) button over this screen, like
  // the other miniapp screens. The import + viewShotRef were already here but the
  // hook was never called, so the Notify miniapp had no capsule menu.
  useRegisterCapsule({
    packageName: notifyPackageName,
    viewShotRef,
    visibleOnRoutes: ["/miniapps/settings/notifications"],
  })

  const [apps, setApps] = useState<InstalledApp[]>([])
  const [blocklist, setBlocklist] = useSetting(SETTINGS.notifications_blocklist.key)
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    loadInstalledApps()
  }, [])

  const loadInstalledApps = async () => {
    if (Platform.OS !== "android") {
      setLoading(false)
      setRefreshing(false)
      return
    }
    try {
      const installedApps = await engine.phoneNotifications.installedApps()

      // Sort alphabetically by app name
      setApps([...installedApps].sort((a, b) => a.appName.localeCompare(b.appName)))
    } catch (error) {
      console.error("Error loading apps:", error)
      Toast.show({
        type: "error",
        text1: translate("settings:notificationsFailedLoad"),
        text2: translate("settings:notificationsFailedLoadRetry"),
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const toggleApp = useCallback(
    async (packageName: string, currentlyBlocked: boolean) => {
      try {
        const newBlockedState = !currentlyBlocked
        const currentBlocklist = Array.isArray(blocklist) ? blocklist : []

        // if the app is in the blacklist, remove it
        if (!newBlockedState) {
          // Remove from blocklist (filter out all instances to handle duplicates)
          setBlocklist(currentBlocklist.filter((appName: string) => appName !== packageName))
        } else {
          // Add to blocklist, using Set to remove any duplicates
          setBlocklist([...new Set([...currentBlocklist, packageName])])
        }

        Toast.show({
          type: newBlockedState ? "info" : "success",
          text1: newBlockedState
            ? translate("settings:notificationsBlocked")
            : translate("settings:notificationsEnabled"),
          text2: apps.find((a) => a.packageName === packageName)?.appName || packageName,
        })
      } catch (error) {
        console.error("Error toggling app:", error)
        Toast.show({
          type: "error",
          text1: translate("settings:notificationsFailedUpdate"),
        })
      }
    },
    [apps, blocklist, setBlocklist],
  )

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    loadInstalledApps()
  }, [])

  // Define renderAppItem here, before any conditional returns
  const renderAppItem = useCallback(
    ({item}: {item: AppRow}) => (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: ITEM_HEIGHT,
          paddingHorizontal: theme.spacing.s4,
          backgroundColor: theme.colors.card,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}>
        {/* App Icon - Fixed dimensions */}
        <View
          style={{
            width: 36,
            height: 36,
            marginRight: theme.spacing.s4,
            borderRadius: 8,
            backgroundColor: theme.colors.primary_foreground,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}>
          {item.icon ? (
            <Image
              source={{uri: `data:image/png;base64,${item.icon}`}}
              style={{width: 32, height: 32, borderRadius: 6}}
              resizeMode="contain"
            />
          ) : (
            <Text style={{fontSize: 16, color: theme.colors.textDim, fontWeight: "600"}}>
              {item.appName.charAt(0).toUpperCase()}
            </Text>
          )}
        </View>

        {/* App Info - Flex to fill space */}
        <View style={{flex: 1, marginRight: theme.spacing.s3, justifyContent: "center"}}>
          <Text
            style={{
              fontSize: 14,
              fontWeight: "500",
              color: theme.colors.text,
            }}
            numberOfLines={1}>
            {item.appName}
          </Text>
        </View>

        {/* Toggle Switch - Fixed position */}
        <Switch value={!item.isBlocked} onValueChange={() => toggleApp(item.packageName, item.isBlocked)} />
      </View>
    ),
    [theme, toggleApp],
  )

  // Memoize filtered apps to prevent recalculation. Blocked state comes from the
  // setting so switches update as soon as it changes, without reloading apps.
  const filteredApps = useMemo(() => {
    const blocked = new Set(Array.isArray(blocklist) ? blocklist : [])
    return apps
      .filter(
        (app) =>
          app.appName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          app.packageName.toLowerCase().includes(searchQuery.toLowerCase()),
      )
      .map((app): AppRow => ({...app, isBlocked: blocked.has(app.packageName)}))
  }, [apps, blocklist, searchQuery])

  const enabledCount = filteredApps.filter((app) => !app.isBlocked).length

  // Enable or disable every app currently listed (all apps, or the search results)
  const setListedAppsBlocked = useCallback(
    (blocked: boolean) => {
      const currentBlocklist = Array.isArray(blocklist) ? blocklist : []
      setBlocklist(
        setPackagesBlocked(
          currentBlocklist,
          filteredApps.map((app) => app.packageName),
          blocked,
        ),
      )
    },
    [blocklist, filteredApps, setBlocklist],
  )

  // Extract keyExtractor to prevent recreation
  const keyExtractor = useCallback((item: AppRow) => item.packageName, [])

  if (loading) {
    return (
      <Screen preset="fixed" ref={viewShotRef}>
        <Header title={translate("settings:notificationsSettings")} />
        <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          <Text style={{color: theme.colors.textDim, marginTop: theme.spacing.s4}}>
            {translate("settings:notificationsLoadingApps")}
          </Text>
        </View>
      </Screen>
    )
  }

  // Show iOS message if on iOS
  if (Platform.OS === "ios") {
    return (
      <Screen preset="fixed" ref={viewShotRef}>
        <Header title={translate("settings:notificationsSettings")} />
        <ScrollView>
          <NativeNotificationSettings />
        </ScrollView>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed" ref={viewShotRef}>
      <Header title={translate("settings:notificationsSettings")} />

      {/* Explanatory Text */}
      <View
        style={{
          paddingHorizontal: theme.spacing.s4,
          paddingVertical: theme.spacing.s3,
        }}>
        <Text
          style={{
            fontSize: 13,
            color: theme.colors.textDim,
            lineHeight: 18,
            marginBottom: theme.spacing.s2,
          }}>
          {translate("settings:notificationsDescription")}
        </Text>
      </View>

      {/* Search Bar */}
      <View
        style={{
          paddingHorizontal: theme.spacing.s4,
          paddingBottom: theme.spacing.s3,
        }}>
        <TextInput
          placeholder={translate("settings:notificationsSearchApps")}
          placeholderTextColor={theme.colors.textDim}
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={{
            borderRadius: theme.spacing.s3,
            paddingHorizontal: theme.spacing.s4,
            paddingVertical: theme.spacing.s2,
            fontSize: 15,
            color: theme.colors.text,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        />
      </View>

      {/* Stats and bulk actions */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: theme.spacing.s4,
          paddingVertical: theme.spacing.s2,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}>
        <Text style={{flex: 1, fontSize: 12, color: theme.colors.textDim, fontWeight: "500"}}>
          {translate("settings:notificationsAppsEnabled", {
            enabled: enabledCount,
            total: filteredApps.length,
          })}
        </Text>
        <PillButton
          tx="settings:notificationsEnableAll"
          variant="secondary"
          buttonStyle={{height: 30, paddingVertical: 4, paddingHorizontal: theme.spacing.s3}}
          textStyle={{fontSize: 13}}
          disabled={enabledCount === filteredApps.length}
          onPress={() => setListedAppsBlocked(false)}
        />
        <PillButton
          tx="settings:notificationsDisableAll"
          variant="secondary"
          buttonStyle={{
            height: 30,
            paddingVertical: 4,
            paddingHorizontal: theme.spacing.s3,
            marginLeft: theme.spacing.s2,
          }}
          textStyle={{fontSize: 13}}
          disabled={enabledCount === 0}
          onPress={() => setListedAppsBlocked(true)}
        />
      </View>

      {/* Apps List */}
      <FlatList
        ListHeaderComponent={<NativeNotificationSettings />}
        data={filteredApps}
        keyExtractor={keyExtractor}
        renderItem={renderAppItem}
        contentContainerStyle={{paddingBottom: theme.spacing.s8}}
        onRefresh={onRefresh}
        refreshing={refreshing}
        removeClippedSubviews={false}
        maxToRenderPerBatch={20}
        windowSize={21}
        initialNumToRender={20}
        updateCellsBatchingPeriod={50}
        maintainVisibleContentPosition={{minIndexForVisible: 0}}
        ListEmptyComponent={
          <View style={{flex: 1, alignItems: "center", marginTop: theme.spacing.s12}}>
            <Text style={{color: theme.colors.textDim}}>
              {searchQuery
                ? translate("settings:notificationsNoAppsFoundSearch")
                : translate("settings:notificationsNoAppsFound")}
            </Text>
          </View>
        }
      />
    </Screen>
  )
}
