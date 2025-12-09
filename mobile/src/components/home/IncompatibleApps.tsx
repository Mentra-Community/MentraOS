import {BottomSheetBackdrop, BottomSheetModal, BottomSheetView} from "@gorhom/bottom-sheet"
import {useCallback, useMemo, useRef} from "react"
import {FlatList, ImageStyle, TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {translate} from "@/i18n"
import {ClientAppletInterface, DUMMY_APPLET, useIncompatibleApps} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"

const GRID_COLUMNS = 4

export const IncompatibleApps: React.FC = () => {
  const {themed, theme} = useAppTheme()
  const incompatibleApps = useIncompatibleApps()
  const bottomSheetRef = useRef<BottomSheetModal>(null)

  const snapPoints = useMemo(() => ["50%", "75%"], [])

  const gridData = useMemo(() => {
    const totalItems = incompatibleApps.length
    const remainder = totalItems % GRID_COLUMNS
    const emptySlots = remainder === 0 ? 0 : GRID_COLUMNS - remainder

    const paddedApps = [...incompatibleApps]
    for (let i = 0; i < emptySlots; i++) {
      paddedApps.push(DUMMY_APPLET)
    }

    return paddedApps
  }, [incompatibleApps])

  const handleOpenSheet = useCallback(() => {
    bottomSheetRef.current?.present()
  }, [])

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />,
    [],
  )

  const handleAppPress = useCallback(
    (app: ClientAppletInterface) => {
      const missingHardware =
        app.compatibility?.missingRequired?.map(req => req.type.toLowerCase()).join(", ") || "required features"

      showAlert(
        translate("home:hardwareIncompatible"),
        app.compatibility?.message ||
          translate("home:hardwareIncompatibleMessage", {
            app: app.name,
            missing: missingHardware,
          }),
        [{text: translate("common:ok")}],
        {
          iconName: "alert-circle-outline",
          iconColor: theme.colors.error,
        },
      )
    },
    [theme],
  )

  const renderItem = useCallback(
    ({item}: {item: ClientAppletInterface}) => {
      if (!item.name) {
        return <View style={themed($gridItem)} />
      }

      return (
        <TouchableOpacity style={themed($gridItem)} onPress={() => handleAppPress(item)} activeOpacity={0.7}>
          <View style={themed($appContainer)}>
            <AppIcon app={item as any} style={themed($appIcon)} />
          </View>
          <Text text={item.name} style={themed($appNameIncompatible)} numberOfLines={2} />
        </TouchableOpacity>
      )
    },
    [themed, handleAppPress],
  )

  if (incompatibleApps.length === 0) {
    return null
  }

  return (
    <>
      <TouchableOpacity style={themed($trigger)} onPress={handleOpenSheet} activeOpacity={0.7}>
        <Text
          style={themed($triggerText)}
          text={translate("home:incompatibleAppsCount", {count: incompatibleApps.length})}
        />
      </TouchableOpacity>

      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundStyle={themed($sheetBackground)}
        handleIndicatorStyle={themed($handleIndicator)}>
        <BottomSheetView style={themed($sheetContent)}>
          <Text style={themed($sheetTitle)} tx="home:incompatibleApps" />
          <FlatList
            data={gridData}
            renderItem={renderItem}
            keyExtractor={item => item.packageName}
            numColumns={GRID_COLUMNS}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={themed($gridContent)}
          />
        </BottomSheetView>
      </BottomSheetModal>
    </>
  )
}

const $trigger: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingVertical: spacing.s4,
  marginBottom: spacing.s4,
})

const $triggerText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.textDim,
})

const $sheetBackground: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.primary_foreground,
})

const $handleIndicator: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.textDim,
})

const $sheetContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  paddingHorizontal: spacing.s4,
})

const $sheetTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 18,
  fontWeight: "700",
  color: colors.text,
  marginBottom: spacing.s4,
  textAlign: "center",
})

const $gridContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingBottom: spacing.s3,
})

const $gridItem: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  alignItems: "center",
  marginVertical: spacing.s3,
  paddingHorizontal: spacing.s2,
})

const $appContainer: ThemedStyle<ViewStyle> = () => ({
  position: "relative",
  width: 64,
  height: 64,
})

const $appIcon: ThemedStyle<ImageStyle> = ({spacing}) => ({
  width: 64,
  height: 64,
  borderRadius: spacing.s3,
  opacity: 0.4,
})

const $appNameIncompatible: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.textDim,
  textAlign: "center",
  marginTop: spacing.s1,
  lineHeight: 14,
  opacity: 0.6,
})
