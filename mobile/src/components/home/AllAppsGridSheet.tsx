import {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {AppState, BackHandler, Keyboard, Platform, TextInput, TouchableOpacity, View} from "react-native"
import {Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  useBottomSheetTimingConfigs,
} from "@gorhom/bottom-sheet"
import {Easing} from "react-native-reanimated"
import {AppsGrid} from "@/components/home/AppsGrid"
import {translate} from "@/i18n"
import GlassView from "@/components/ui/GlassView"

const GRID_COLUMNS = 4

export default function AllAppsGridSheet({bottomSheetRef}: {bottomSheetRef: React.RefObject<BottomSheet | null>}) {
  const {theme} = useAppTheme()

  const [searchQuery, setSearchQuery] = useState("")
  const [isOpen, setIsOpen] = useState(false)
  const searchInputRef = useRef<TextInput>(null)

  const snapPoints = useMemo(() => ["90%"], [])

  // Slow the sheet's open/close animation down (~2x the library default) so the
  // Android back-gesture dismiss doesn't snap shut instantly — it reads as an
  // abrupt pop without this. Applies to both the gesture-driven close and the
  // programmatic close() we call from the BackHandler below.
  const animationConfigs = useBottomSheetTimingConfigs({
    duration: 500,
    easing: Easing.out(Easing.cubic),
  })

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

  // Android: the hardware/native back gesture should dismiss the sheet. It's an
  // overlay (not a route), so navigation never sees it — register a BackHandler
  // while open and consume the event so it doesn't fall through to navigating
  // away from home.
  useEffect(() => {
    if (Platform.OS !== "android" || !isOpen) return
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      bottomSheetRef.current?.close()
      return true
    })
    return () => sub.remove()
  }, [isOpen, bottomSheetRef])

  // The sheet's own onChange only fires blur+dismiss when it closes via its own
  // gesture/programmatic close() path. If the user backgrounds the whole app
  // (Home button, app switcher) while the search field is still focused and the
  // sheet never closes, the ReactEditText keeps the IME's served view — Android
  // then re-shows the keyboard over whatever screen is on top on the next
  // resume. Blur + dismiss on the background AppState transition closes that
  // gap regardless of how the app left the foreground. Only "background"
  // qualifies: iOS also emits "inactive" for transient interruptions
  // (Notification Center, app switcher peek, incoming calls) where dropping
  // focus would wrongly hide the keyboard on return. Check this field's focus
  // before the global dismiss so a still-mounted sheet cannot blur an input in
  // another screen or foregrounded miniapp.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background" && searchInputRef.current?.isFocused()) {
        searchInputRef.current.blur()
        Keyboard.dismiss()
      }
    })
    return () => sub.remove()
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
        animationConfigs={animationConfigs}
        animateOnMount={false}
        onChange={(idx) => {
          const open = idx >= 0
          setIsOpen(open)
          // When the sheet closes, drop focus from the search field and hide the
          // keyboard. The sheet stays mounted (index -1) on the home screen, so a
          // search field left focused keeps holding the IME's served view — which
          // Android then auto-restores on every app resume (singleTask +
          // adjustResize), popping the keyboard up over whatever screen is on top.
          if (!open) {
            searchInputRef.current?.blur()
            Keyboard.dismiss()
          }
        }}
        backdropComponent={renderBackdrop}
        backgroundComponent={(props: any) => {
          if (Platform.OS === "android") {
            return <View className="rounded-3xl -mx-px bg-background" {...props} />
          }
          return <GlassView className="rounded-3xl -mx-px" {...props} />
        }}
        enablePanDownToClose
        enableDynamicSizing={false}
        backgroundStyle={{backgroundColor: theme.colors.background}}
        handleIndicatorStyle={{backgroundColor: theme.colors.muted_foreground + "40", width: 64, height: 6}}
        handleStyle={{height: 32 + 6, alignSelf: "center", justifyContent: "center"}}>
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
              <View className="flex-row items-center rounded-2xl px-4 h-12 bg-primary-foreground">
                <Icon name="search" size={20} color={theme.colors.muted_foreground} />
                <TextInput
                  ref={searchInputRef}
                  placeholder={translate("home:search")}
                  placeholderTextColor={theme.colors.muted_foreground}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  className="flex-1 ml-2 text-foreground text-lg"
                  style={{color: theme.colors.foreground, lineHeight: 21.5}}
                  hitSlop={16}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity onPress={() => setSearchQuery("")}>
                    <Icon name="x" size={20} color={theme.colors.muted_foreground} />
                  </TouchableOpacity>
                )}
              </View>
              {/* <View className="h-px bg-border my-4" /> */}
            </View>
            <View className="h-2" />
            <AppsGrid
              showPlaceholders={!isOpen}
              // The sheet stays mounted while closed (index -1), so its skeleton
              // does too — freeze the pulse or it animates the app at 60fps from
              // behind the home screen forever.
              skeletonPulse={isOpen}
              gateOnIconsReady={true}
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
