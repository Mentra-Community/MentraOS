import {useFocusEffect} from "expo-router"
import {useCallback} from "react"
import {View, Platform, Pressable, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {ThemedStyle} from "@/theme"
import {textEditorStore} from "@/utils/TextEditorStore"
import {useAppTheme} from "@/utils/useAppTheme"

type TextSettingNoSaveProps = {
  label: string
  value: string
  onChangeText: (text: string) => void
  settingKey: string
  isFirst?: boolean
  isLast?: boolean
}

const TextSettingNoSave: React.FC<TextSettingNoSaveProps> = ({
  label,
  value,
  onChangeText,
  settingKey,
  isFirst,
  isLast,
}) => {
  const {theme, themed} = useAppTheme()

  const groupedStyle: ViewStyle | undefined =
    isFirst !== undefined || isLast !== undefined
      ? {
          borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          marginBottom: isLast ? 0 : theme.spacing.s2,
        }
      : undefined
  const {push} = useNavigationHistory()

  // Check for pending value when component gets focus
  useFocusEffect(
    useCallback(() => {
      // Only process if there's actually a pending value (meaning we just returned from text editor)
      const pendingValue = textEditorStore.getPendingValue()
      if (pendingValue && pendingValue.key === settingKey) {
        onChangeText(pendingValue.value)
        textEditorStore.setPendingValue(pendingValue.key, "") // Only clear when we use it
      } else if (pendingValue) {
        // If there's a pending value but it doesn't match, put it back
        textEditorStore.setPendingValue(pendingValue.key, pendingValue.value)
      }
    }, [settingKey]),
  )

  const handleOpenEditor = () => {
    push("/applet/text-editor", {label, value, settingKey})
  }

  return (
    <View style={[themed($container), groupedStyle]}>
      <Text style={themed($label)}>{label}</Text>

      <Pressable
        style={({pressed}) => [themed($button), pressed && themed($buttonPressed)]}
        onPress={handleOpenEditor}
        android_ripple={{color: "rgba(0, 0, 0, 0.1)"}}>
        <Text style={themed($buttonText)} numberOfLines={2} ellipsizeMode="tail">
          {value || "Tap to edit..."}
        </Text>
      </Pressable>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $button: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.background,
  borderRadius: Platform.OS === "ios" ? 8 : 4,
  borderWidth: 1,
  borderColor: colors.border,
  justifyContent: "center",
  minHeight: Platform.OS === "ios" ? 44 : 48,
  padding: Platform.OS === "ios" ? 12 : 10,
})

const $buttonPressed: ThemedStyle<ViewStyle> = () => ({
  backgroundColor: Platform.OS === "ios" ? "rgba(0, 0, 0, 0.05)" : "transparent",
  opacity: Platform.OS === "ios" ? 0.8 : 1,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  color: colors.text,
})

export default TextSettingNoSave
