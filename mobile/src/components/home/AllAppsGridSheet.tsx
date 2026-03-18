import {useCallback, useEffect, useMemo, useState} from "react"
import {TextInput, TouchableOpacity, View} from "react-native"
import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import BottomSheet, {BottomSheetBackdrop, BottomSheetScrollView} from "@gorhom/bottom-sheet"
import {AppsGrid} from "@/components/home/AppsGrid"
import {translate} from "@/i18n"
import GlassView from "@/components/ui/GlassView"

const GRID_COLUMNS = 4

export default function AllAppsGridSheet({bottomSheetRef}: {bottomSheetRef: React.RefObject<BottomSheet | null>}) {
  const {theme} = useAppTheme()

  const [searchQuery, setSearchQuery] = useState("")

  const snapPoints = useMemo(() => ["90%"], [])

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} pressBehavior="close" />,
    [],
  )

  useEffect(() => {
    requestAnimationFrame(() => {
      // fix for some samsung devices:
      setTimeout(() => {
        bottomSheetRef.current?.close()
      }, 100)
    })
  }, [])

  return (
    <>
      <BottomSheet
        // style={{position: "relative", bottom: 0, left: 0, right: 0, top: 0, width: 500}}
        // style={{position: "absolute", bottom: 0, left: 0, right: 0, top: 0, width: 500}}
        // containerStyle={{position: "absolute", left: 0}}
        index={-1}
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        animateOnMount={false}
        backdropComponent={renderBackdrop}
        backgroundComponent={(props: any) => <GlassView className="rounded-2xl -mx-px" {...props} />}
        enablePanDownToClose
        enableDynamicSizing={false}
        backgroundStyle={{backgroundColor: theme.colors.background}}
        handleIndicatorStyle={{backgroundColor: theme.colors.muted_foreground, width: 100, height: 5}}>
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
      </BottomSheet>
    </>
  )
}
