import {useCallback, useMemo} from "react"
import {FlatList, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {
  ClientAppletInterface,
  DUMMY_APPLET,
  getMoreAppsApplet,
  useBackgroundApps,
  useStartApplet,
} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

const GRID_COLUMNS = 4

export const BackgroundAppsGrid = () => {
  const {themed, theme} = useAppTheme()
  const {inactive} = useBackgroundApps()
  const startApplet = useStartApplet()
  const {push} = useNavigationHistory()

  const gridData = useMemo(() => {
    // Filter out incompatible apps and running apps
    let inactiveApps = inactive.filter(app => {
      if (!app.compatibility?.isCompatible) {
        return false
      }
      return true
    })

    // sort alphabetically
    inactiveApps.sort((a, b) => {
      return a.name.localeCompare(b.name)
    })
    inactiveApps.push(getMoreAppsApplet())

    // Calculate how many empty placeholders we need to fill the last row
    const totalItems = inactiveApps.length
    const remainder = totalItems % GRID_COLUMNS
    const emptySlots = remainder === 0 ? 0 : GRID_COLUMNS - remainder

    // Add empty placeholders to align items to the left
    for (let i = 0; i < emptySlots; i++) {
      inactiveApps.push(DUMMY_APPLET)
    }

    return inactiveApps
  }, [inactive])

  const handlePress = async (app: ClientAppletInterface) => {
    const getMoreApplet = getMoreAppsApplet()
    if (app.packageName === getMoreApplet.packageName) {
      push(getMoreApplet.offlineRoute)
      return
    }

    const result = await askPermissionsUI(app, theme)
    if (result !== 1) {
      return
    }

    startApplet(app.packageName)
  }

  const renderItem = useCallback(
    ({item}: {item: ClientAppletInterface}) => {
      // Don't render empty placeholders
      if (!item.name) {
        return <View style={themed($gridItem)} />
      }

      // small hack to help with some long app names:
      const numberOfLines = item.name.split(" ").length > 1 ? 2 : 1
      let size = 12
      if (numberOfLines == 1 && item.name.length > 10) {
        size = 11
      }

      return (
        <TouchableOpacity style={themed($gridItem)} onPress={() => handlePress(item)} activeOpacity={0.7}>
          <AppIcon app={item} style={themed($appIcon)} />
          <Text
            text={item.name}
            style={[themed(!item.healthy ? $appNameOffline : $appName), {fontSize: size}]}
            numberOfLines={numberOfLines}
            ellipsizeMode="tail"
          />
        </TouchableOpacity>
      )
    },
    [themed, theme, startApplet],
  )

  return (
    <View style={themed($container)}>
      <View style={themed($header)}>
        <Text tx="home:inactiveApps" style={themed($headerText)} />
      </View>
      <FlatList
        data={gridData}
        renderItem={renderItem}
        keyExtractor={item => item.packageName}
        numColumns={GRID_COLUMNS}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={themed($gridContent)}
      />
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  marginTop: spacing.s3,
})

const $gridContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.s4,
})

const $gridItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  alignItems: "center",
  marginVertical: spacing.s3,
})

const $header: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingBottom: spacing.s3,
})

const $headerText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 20,
  fontWeight: 600,
  color: colors.secondary_foreground,
})

const $appIcon: ThemedStyle<ViewStyle> = () => ({
  width: 64,
  height: 64,
  // borderRadius is handled by AppIcon component based on squircle settings
})

const $appName: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.text,
  textAlign: "center",
  marginTop: spacing.s1,
  lineHeight: 14,
  // overflow: "hidden",
  // wordWrap: "break-word",
})

const $appNameOffline: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.textDim,
  textAlign: "center",
  marginTop: spacing.s1,
  textDecorationLine: "line-through",
  lineHeight: 14,
})
