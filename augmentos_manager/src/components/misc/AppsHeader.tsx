import {translate, TxKeyPath} from "@/i18n"
import {colors, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import SearchIcon from "assets/icons/component/SearchIcon"
import { router } from "expo-router"
import * as React from "react"
import {View, TextStyle, ViewStyle, Pressable} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"
import { Text } from "@/components/ignite"


const AppsHeader = ({ showSearchIcon = true, title }: { showSearchIcon?: boolean, title: TxKeyPath }) => {  const {themed, theme} = useAppTheme()

  return (
    <View style={themed($listHeaderIcon)}>
      <View style={themed($tableHeader)}>
        <Text text={translate(title)} style={themed($appsHeader)} />
      </View>
      {showSearchIcon && (
        <Pressable
          style={themed($wrapper)}
          onPress={() => {
            router.push('/search/search');
          }}>
          <SearchIcon color={theme.colors.text} />
        </Pressable>
      )}
    </View>
  )
}

export default AppsHeader

const $appsHeader: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 15,
  letterSpacing: 0.6,
  lineHeight: 20,
  fontWeight: "500",
  color: colors.text,
  textAlign: "left",
})

const $tableHeader: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
})

const $listHeaderIcon: ThemedStyle<ViewStyle> = () => ({
  marginBottom: 12,
  flex: 1,
  alignItems: "center",
  justifyContent: "space-between",
  paddingVertical: 0,
  gap: 0,
  flexDirection: "row",
  width: "100%",
})
const $wrapper: ThemedStyle<ViewStyle> = () => ({
  width: 24,
  height: 20,
})
