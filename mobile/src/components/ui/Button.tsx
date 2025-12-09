import ChevronRight from "assets/icons/component/ChevronRight"
import {ReactNode} from "react"
import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface ButtonProps {
  title: string
  onPress: () => void
  icon: ReactNode
}

const Button = ({title, onPress, icon}: ButtonProps) => {
  const {themed} = useAppTheme()
  return (
    <TouchableOpacity onPress={onPress} style={themed($padding)}>
      {/*<LinearGradient {...linearGradientProps}>*/}
      <View style={[themed($insideSpacing), themed($insideFlexBox)]}>
        <View style={[themed($inside), themed($insideFlexBox)]}>
          {icon}
          <View style={[themed($miraWrapper), themed($insideFlexBox)]}>
            <Text text={title} style={themed($mira)} numberOfLines={1} />
          </View>
        </View>
        <ChevronRight />
      </View>
      {/*</LinearGradient>*/}
    </TouchableOpacity>
  )
}

const $insideFlexBox: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
})

const $mira: ThemedStyle<TextStyle> = () => ({
  fontSize: 17,
  letterSpacing: 0.3,
  lineHeight: 23,
  fontWeight: "500",
  color: "#fff",
  textAlign: "center",
  overflow: "hidden",
})

const $miraWrapper: ThemedStyle<ViewStyle> = () => ({
  width: 265,
})

const $inside: ThemedStyle<ViewStyle> = () => ({
  gap: 20,
})

const $insideSpacing: ThemedStyle<ViewStyle> = () => ({
  borderRadius: 30,
  backgroundColor: "#0f1861",
  width: "100%",
  minHeight: 44,
  justifyContent: "space-between",
  paddingHorizontal: 16,
  paddingVertical: 8,
  gap: 0,
  overflow: "hidden",
})

const $padding: ThemedStyle<ViewStyle> = () => ({
  paddingHorizontal: 8,
  paddingVertical: 16,
  marginVertical: 8,
})

export default Button
