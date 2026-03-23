import AppIcon from "@/components/home/AppIcon"
import {useCallback, useMemo, useRef, useState} from "react"
import {TextInput, TouchableOpacity, View} from "react-native"
import {Button, Icon, Text} from "@/components/ignite"
import {ClientAppletInterface, DUMMY_APPLET, useApplets} from "@/stores/applets"
import {useAppTheme} from "@/contexts/ThemeContext"
import {BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView} from "@gorhom/bottom-sheet"
import {AppsGrid} from "@/components/home/AppsGrid"
import {translate} from "@/i18n"

const GRID_COLUMNS = 4

export default function AllAppsGridButton({onPress}: {onPress: () => void}) {
  const {theme} = useAppTheme()

  return (
    <>
      <Button
        compactIcon
        onPress={onPress}
        hitSlop={10}
        className="flex-1 border-0 px-0 py-0 rounded-none bg-transparent">
        <Icon name="grid-3x3" color={theme.colors.foreground} size={32} />
      </Button>
      {/* <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        enableDynamicSizing={false}
        backgroundStyle={{backgroundColor: theme.colors.background}}
        handleIndicatorStyle={{backgroundColor: theme.colors.primary_foreground, width: 100, height: 5}}>
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
      </BottomSheetModal> */}
    </>
  )
}
