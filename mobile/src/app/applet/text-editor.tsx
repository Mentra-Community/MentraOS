import {useLocalSearchParams} from "expo-router"
import {useState, useRef, useEffect} from "react"
import {View, TextInput, Platform, ScrollView, TextStyle, ViewStyle, TouchableOpacity} from "react-native"
import {SafeAreaView} from "react-native-safe-area-context"

import {Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {ThemedStyle} from "@/theme"
import {textEditorStore} from "@/utils/TextEditorStore"
import {useAppTheme} from "@/utils/useAppTheme"

export default function TextEditorScreen() {
  const {label, value, settingKey} = useLocalSearchParams()
  const [tempValue, setTempValue] = useState((value as string) || "")
  const {theme, themed} = useAppTheme()
  const textInputRef = useRef<TextInput>(null)
  const {goBack} = useNavigationHistory()

  // Auto-focus text input when screen opens
  useEffect(() => {
    const timer = setTimeout(
      () => {
        textInputRef.current?.focus()
      },
      Platform.OS === "android" ? 200 : 100,
    )

    return () => clearTimeout(timer)
  }, [])

  const handleSave = () => {
    // Store the value before navigating back
    textEditorStore.setPendingValue(settingKey as string, tempValue)

    goBack()
  }

  const handleCancel = () => {
    goBack()
  }

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <SafeAreaView style={themed($safeArea)} edges={["top"]}>
        {/* Custom header for proper iOS styling */}
        <View style={themed($header)}>
          <TouchableOpacity onPress={handleCancel} style={themed($headerButton)}>
            <Text text="Cancel" style={themed($cancelButtonText)} />
          </TouchableOpacity>

          <Text text={label as string} style={themed($headerTitle)} numberOfLines={1} />

          <TouchableOpacity onPress={handleSave} style={themed($headerButton)}>
            <Text text="Done" style={themed($doneButtonText)} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={themed($scrollContent)} keyboardShouldPersistTaps="handled">
          <TextInput
            ref={textInputRef}
            style={themed($textInput)}
            value={tempValue}
            onChangeText={setTempValue}
            multiline
            maxLength={10000}
            textAlignVertical="top"
            scrollEnabled={true}
            placeholderTextColor={theme.colors.textDim}
            autoCapitalize="none"
          />
        </ScrollView>
      </SafeAreaView>
    </Screen>
  )
}

const $safeArea: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  backgroundColor: colors.background,
})

const $header: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  height: Platform.OS === "ios" ? 44 : 56,
  paddingHorizontal: Platform.OS === "ios" ? 8 : 16,
  borderBottomWidth: Platform.OS === "ios" ? 0.5 : 1,
  borderBottomColor: colors.border,
  backgroundColor: colors.background,
})

const $headerTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: Platform.OS === "ios" ? 17 : 20,
  fontWeight: Platform.OS === "ios" ? "600" : "bold",
  color: colors.text,
  flex: 1,
  textAlign: "center",
})

const $headerButton: ThemedStyle<ViewStyle> = () => ({
  paddingVertical: 8,
  paddingHorizontal: Platform.OS === "ios" ? 12 : 16,
  minWidth: Platform.OS === "ios" ? 70 : 80,
  alignItems: Platform.OS === "ios" ? "flex-start" : "center",
})

const $cancelButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: Platform.OS === "ios" ? 17 : 16,
  color: Platform.OS === "ios" ? "#007AFF" : colors.text,
})

const $doneButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: Platform.OS === "ios" ? 17 : 16,
  color: Platform.OS === "ios" ? "#007AFF" : colors.text,
  fontWeight: Platform.OS === "ios" ? "600" : "bold",
})

const $scrollContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexGrow: 1,
  padding: spacing.s4,
})

const $textInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  fontSize: 16,
  borderWidth: Platform.OS === "ios" ? 0.5 : 1,
  borderColor: colors.border,
  borderRadius: Platform.OS === "ios" ? 10 : 4,
  padding: spacing.s4,
  textAlignVertical: "top",
  backgroundColor: colors.background,
  color: colors.text,
  minHeight: 150,
})
