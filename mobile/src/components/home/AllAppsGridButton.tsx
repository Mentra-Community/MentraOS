import AppIcon from "@/components/home/AppIcon"
import {useCallback, useMemo, useRef, useState} from "react"
import {TextInput, TouchableOpacity, View} from "react-native"
import {Button, Icon, Text} from "@/components/ignite"
import {ClientAppletInterface, DUMMY_APPLET, useApplets} from "@/stores/applets"
import {useAppTheme} from "@/contexts/ThemeContext"
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetView,
} from "@gorhom/bottom-sheet"
import {AppsGrid} from "@/components/home/AppsGrid"
import {translate} from "@/i18n"

const GRID_COLUMNS = 4

export default function AllAppsGridButton() {
  const {theme} = useAppTheme()
  const apps = useApplets()
  const bottomSheetRef = useRef<BottomSheetModal>(null)
  const [searchQuery, setSearchQuery] = useState("")

  const snapPoints = useMemo(() => ["90%"], [])

  const gridData = useMemo(() => {
    const totalItems = apps.length
    const remainder = totalItems % GRID_COLUMNS
    const emptySlots = remainder === 0 ? 0 : GRID_COLUMNS - remainder

    const paddedApps = [...apps]
    for (let i = 0; i < emptySlots; i++) {
      paddedApps.push(DUMMY_APPLET)
    }

    return paddedApps
  }, [apps])

  const handleOpenSheet = useCallback(() => {
    bottomSheetRef.current?.present()
  }, [])

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />,
    [],
  )
  const renderItem = useCallback(({item}: {item: ClientAppletInterface}) => {
    if (!item.name) {
      return <View className="flex-1 items-center my-3 px-2" />
    }

    return (
      <TouchableOpacity
        className="flex-1 items-center my-3 px-2"
        //   onPress={() => handleAppPress(item)}
        // activeOpacity={0.7}>
      >
        <View className="relative w-16 h-16">
          <AppIcon app={item as any} className="w-16 h-16 rounded-xl" />
        </View>
        <Text text={item.name} className="text-xs text-foreground text-center mt-1 leading-[14px]" numberOfLines={2} />
      </TouchableOpacity>
    )
  }, [])

  return (
    <>
      <Button
        compactIcon
        onPress={handleOpenSheet}
        hitSlop={10}
        className="flex-1 border-0 px-0 py-0 rounded-none bg-transparent">
        <Icon name="grid-3x3" color={theme.colors.foreground} size={32} />
      </Button>
      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        enableDynamicSizing={false}
        backgroundStyle={{backgroundColor: theme.colors.background}}
        handleIndicatorStyle={{backgroundColor: theme.colors.primary_foreground, width: 100, height: 5}}>
        {/* <View className="px-4"> */}
        {/* <View className="gap-4 px-4 mb-2">
            <Text className="text-lg font-bold text-foreground text-center" tx="home:apps" />
            <Text className="text-sm text-muted-foreground font-medium" tx="home:incompatibleAppsDescription" />
          </View> */}
        {/* <BottomSheetFlatList
            data={gridData}
            renderItem={renderItem}
            keyExtractor={(item: ClientAppletInterface) => item.packageName}
            numColumns={GRID_COLUMNS}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{paddingBottom: 21 * 4 + 6 * 4 * 2}}
          /> */}
        {/* <AppsGrid /> */}
        {/* </View> */}
        <BottomSheetScrollView>
          <View className="px-6">
            <View className="">
              <View className="flex-row items-center bg-primary-foreground rounded-xl px-4 py-3 mt-4">
                <Icon name="search" size={20} color={theme.colors.muted_foreground} />
                <TextInput
                  placeholder={translate("home:search")}
                  placeholderTextColor={theme.colors.muted_foreground}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  className="flex-1 ml-2 text-foreground"
                  style={{color: theme.colors.foreground}}
                  hitSlop={16}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery("")}>
                    <Icon name="x" size={20} color={theme.colors.muted_foreground} />
                  </TouchableOpacity>
                )}
              </View>
              <View className="h-px bg-border my-4" />
            </View>
            <AppsGrid
              showAllApps={true}
              searchQuery={searchQuery}
              onOpenApp={() => {
                bottomSheetRef.current?.close()
              }}
              onAddToHome={() => {
                bottomSheetRef.current?.close()
              }}
            />
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </>
  )
}
