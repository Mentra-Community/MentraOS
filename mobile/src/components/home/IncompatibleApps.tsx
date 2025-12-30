import {BottomSheetBackdrop, BottomSheetModal, BottomSheetView} from "@gorhom/bottom-sheet"
import {useCallback, useMemo, useRef} from "react"
import {FlatList, TouchableOpacity, View} from "react-native"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {Badge} from "@/components/ui"
import {translate} from "@/i18n"
import {ClientAppletInterface, DUMMY_APPLET, useIncompatibleApps} from "@/stores/applets"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useSafeAreaInsets} from "react-native-safe-area-context"

const GRID_COLUMNS = 4

export const IncompatibleApps: React.FC = () => {
  const {theme} = useAppTheme()
  const incompatibleApps = useIncompatibleApps()
  const bottomSheetRef = useRef<BottomSheetModal>(null)
  const {bottom} = useSafeAreaInsets()

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
        return <View className="flex-1 items-center my-3 px-2" />
      }

      return (
        <TouchableOpacity
          className="flex-1 items-center my-3 px-2"
          onPress={() => handleAppPress(item)}
          activeOpacity={0.7}>
          <View className="relative w-16 h-16">
            <AppIcon app={item as any} className="w-16 h-16 rounded-xl opacity-40" />
          </View>
          <Text
            text={item.name}
            className="text-xs text-muted-foreground text-center mt-1 leading-[14px] opacity-60"
            numberOfLines={2}
          />
        </TouchableOpacity>
      )
    },
    [handleAppPress],
  )

  if (incompatibleApps.length === 0) {
    return null
  }

  const incompatibleAppsCount = incompatibleApps.length

  return (
    <>
      <TouchableOpacity
        onPress={handleOpenSheet}
        activeOpacity={0.8}
        className="bg-primary-foreground py-3 px-2 rounded-2xl flex-row justify-between items-center min-h-[72px] mb-8">
        <View className="flex-row items-center gap-3 flex-1 px-2">
          {/* Stacked app icons */}
          <View className="flex-row items-center">
            {incompatibleApps.slice(0, 3).map((app, index) => (
              <View
                key={app.packageName}
                style={{
                  zIndex: 3 - index,
                  marginLeft: index > 0 ? -theme.spacing.s8 : 0,
                }}>
                <AppIcon app={app} className="w-12 h-12" />
              </View>
            ))}
          </View>

          {/* Text and badge */}
          <View className="flex-col gap-1 flex-1 opacity-40">
            <Text className="font-semibold text-secondary-foreground text-sm">
              {translate("home:incompatibleApps")}
            </Text>
            {incompatibleAppsCount > 0 && (
              <Badge text={`${translate("home:incompatibleAppsCount", {count: incompatibleAppsCount})}`} />
            )}
          </View>
        </View>
      </TouchableOpacity>

      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundStyle={{backgroundColor: theme.colors.primary_foreground}}
        handleIndicatorStyle={{backgroundColor: theme.colors.muted_foreground}}>
        <BottomSheetView className="px-6">
          <View className="gap-4 px-4 my-6">
            <Text className="text-lg font-bold text-foreground text-center" tx="home:incompatibleApps" />
            <Text className="text-sm text-muted-foreground font-medium" tx="home:incompatibleAppsDescription" />
          </View>
          <FlatList
            data={gridData}
            renderItem={renderItem}
            keyExtractor={item => item.packageName}
            numColumns={GRID_COLUMNS}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{paddingBottom: bottom}}
          />
        </BottomSheetView>
      </BottomSheetModal>
    </>
  )
}
