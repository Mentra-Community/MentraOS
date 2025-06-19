import React, {useState} from "react"
import {View, ViewStyle, ScrollView, TextInput, Pressable} from "react-native"
import {router} from "expo-router"
import {Screen} from "@/components/ignite"
import AppsActiveList from "@/components/misc/AppsActiveList"
import AppsInactiveList from "@/components/misc/AppsInactiveList"
import {useAppStatus} from "@/contexts/AppStatusProvider"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {Spacer} from "@/components/misc/Spacer"
import Divider from "@/components/misc/Divider"
import {ArrowLeftIcon} from "assets/icons/component/ArrowLeftIcon"
import {CloseXIcon} from "assets/icons/component/CloseXIcon"
import {translate} from "@/i18n"

export default function SearchAppsPage() {
  const {appStatus} = useAppStatus()
  const {themed, theme} = useAppTheme()
  const [searchQuery, setSearchQuery] = useState("")
  const activeApps = appStatus.filter(app => app.is_running)

  return (
    <Screen preset="fixed" style={themed($screen)} safeAreaEdges={["top"]}>
      <View style={themed($searchContainer)}>
        <Pressable onPress={() => router.back()}>
          <ArrowLeftIcon color={theme.colors.icon} size={24} />
        </Pressable>

        <TextInput
          placeholder={translate("home:search")}
          placeholderTextColor="#aaa"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={themed($searchInput)}
        />
        <Pressable onPress={() => setSearchQuery("")}>
          <CloseXIcon color={theme.colors.icon} size={24} />
        </Pressable>
      </View>

      <ScrollView
        style={themed($scrollView)}
        contentContainerStyle={themed($scrollContent)}
        showsVerticalScrollIndicator={false}>
        {activeApps.length > 0 && (
          <>
            <AppsActiveList isSearchPage={true} searchQuery={searchQuery} />
            <Divider variant="inset" />
          </>
        )}

        <AppsInactiveList isSearchPage={true} searchQuery={searchQuery} />
        <Spacer height={40} />
      </ScrollView>
    </Screen>
  )
}

const $screen: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.lg,
  paddingTop: spacing.md,
  flex: 1,
})

const $searchContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  borderRadius: 24,
  borderWidth: 1,
  borderColor: colors.border,
  paddingHorizontal: spacing.md,
  height: 48,
  backgroundColor: colors.background,
  marginBottom: spacing.md,
})

const $searchInput: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  marginLeft: 12,
  color: colors.text,
  fontSize: 16,
})

const $scrollView: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  marginRight: -spacing.md,
  paddingRight: spacing.md,
})

const $scrollContent: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
})
