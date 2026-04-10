import CoreModule from "core"
import {useState, useEffect, useCallback, useMemo, useRef} from "react"
import {View, Platform, TextInput, FlatList, ActivityIndicator, Image} from "react-native"
import Toast from "react-native-toast-message"

import {Screen, Text, Header, Switch} from "@/components/ignite"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {notifyPackageName} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"

interface InstalledApp {
  packageName: string
  appName: string
  isBlocked: boolean
  icon: string | null
}

// Fixed item height for consistent scrolling
const ITEM_HEIGHT = 64

export default function NotificationSettingsScreen() {
  const {theme} = useAppTheme()
  const viewShotRef = useRef<View>(null)

  const [apps, setApps] = useState<InstalledApp[]>([])
  const [blocklist, setBlocklist] = useSetting(SETTINGS.notifications_blocklist.key)
  const [searchQuery, setSearchQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    loadInstalledApps()
  }, [])

  const loadInstalledApps = async () => {
    try {
      const installedApps = await CoreModule.getInstalledApps()

      // Sort alphabetically by app name
      let sortedApps = installedApps.sort((a: InstalledApp, b: InstalledApp) => a.appName.localeCompare(b.appName))

      // set any apps in the blocklist to be disabled
      // TODO: fix this
      sortedApps.forEach((app) => {
        if (blocklist.includes(app.packageName)) {
          app.isBlocked = true
        }
      })

      setApps(sortedApps)
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

  useEffect(() => {
    loadInstalledApps()
    console.log(blocklist)
  }, [blocklist])

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
    [apps],
  )

  const onRefresh = useCallback(() => {
    setRefreshing(true)
    loadInstalledApps()
  }, [])

  // Define renderAppItem here, before any conditional returns
  const renderAppItem = useCallback(
    ({item}: {item: InstalledApp}) => (
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

  // Simplified getItemLayout with consistent height
  const getItemLayout = useCallback(
    (_: any, index: number) => ({
      length: ITEM_HEIGHT,
      offset: ITEM_HEIGHT * index,
      index,
    }),
    [],
  )

  // Memoize filtered apps to prevent recalculation
  const filteredApps = useMemo(
    () =>
      apps.filter(
        (app) =>
          app.appName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          app.packageName.toLowerCase().includes(searchQuery.toLowerCase()),
      ),
    [apps, searchQuery],
  )

  // Extract keyExtractor to prevent recreation
  const keyExtractor = useCallback((item: InstalledApp) => item.packageName, [])

  if (loading) {
    return (
      <>
        <MiniAppCapsuleMenu packageName={notifyPackageName} viewShotRef={viewShotRef} />
        <Screen preset="fixed" ref={viewShotRef}>
          <Header title={translate("settings:notificationsSettings")} />
          <View style={{flex: 1, justifyContent: "center", alignItems: "center"}}>
            <ActivityIndicator size="large" color={theme.colors.foreground} />
            <Text style={{color: theme.colors.textDim, marginTop: theme.spacing.s4}}>
              {translate("settings:notificationsLoadingApps")}
            </Text>
          </View>
        </Screen>
      </>
    )
  }

  // Show iOS message if on iOS
  if (Platform.OS === "ios") {
    return (
      <>
        <MiniAppCapsuleMenu packageName={notifyPackageName} viewShotRef={viewShotRef} />
        <Screen preset="fixed" ref={viewShotRef}>
          <Header title={translate("settings:notificationsSettings")} />
          <View style={{flex: 1, justifyContent: "center", alignItems: "center", padding: theme.spacing.s6}}>
            <Text
              style={{
                fontSize: 18,
                fontWeight: "600",
                color: theme.colors.text,
                textAlign: "center",
                marginBottom: theme.spacing.s4,
              }}>
              {translate("settings:notificationsIosTitle")}
            </Text>
            <Text style={{color: theme.colors.textDim, textAlign: "center", lineHeight: 22}}>
              {translate("settings:notificationsIosMessage")}
            </Text>
          </View>
        </Screen>
      </>
    )
  }

  return (
    <>
      <MiniAppCapsuleMenu packageName={notifyPackageName} viewShotRef={viewShotRef} />
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

        {/* Stats */}
        <View
          style={{
            paddingHorizontal: theme.spacing.s4,
            paddingVertical: theme.spacing.s2,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}>
          <Text style={{fontSize: 12, color: theme.colors.textDim, fontWeight: "500"}}>
            {translate("settings:notificationsAppsEnabled", {
              enabled: filteredApps.filter((app) => !app.isBlocked).length,
              total: filteredApps.length,
            })}
          </Text>
        </View>

        {/* Apps List */}
        <FlatList
          data={filteredApps}
          keyExtractor={keyExtractor}
          renderItem={renderAppItem}
          contentContainerStyle={{paddingBottom: theme.spacing.s8}}
          onRefresh={onRefresh}
          refreshing={refreshing}
          getItemLayout={getItemLayout}
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
    </>
  )
}
