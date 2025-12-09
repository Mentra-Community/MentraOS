import {MaterialCommunityIcons} from "@expo/vector-icons"
import {useEffect, useRef} from "react"
import {Animated, TouchableOpacity, View, TextStyle, ViewStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface AdvancedSettingsDropdownProps {
  isOpen: boolean
  onToggle: () => void
  children: React.ReactNode
}

export function AdvancedSettingsDropdown({isOpen, onToggle, children}: AdvancedSettingsDropdownProps) {
  const {theme, themed} = useAppTheme()
  const fadeAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: isOpen ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start()
  }, [isOpen, fadeAnim])

  return (
    <>
      <TouchableOpacity style={themed($button)} onPress={onToggle} activeOpacity={0.7}>
        <View style={themed($content)}>
          <Text tx="deviceSettings:advancedSettings" style={themed($label)} />
          <MaterialCommunityIcons
            name={isOpen ? "chevron-up" : "chevron-down"}
            size={24}
            color={theme.colors.textDim}
          />
        </View>
      </TouchableOpacity>

      {isOpen && <Animated.View style={{opacity: fadeAnim}}>{children}</Animated.View>}
    </>
  )
}

const $button: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
  // borderWidth: 2,
  // borderColor: colors.border,
})

const $content: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 16,
  fontWeight: "600",
})
