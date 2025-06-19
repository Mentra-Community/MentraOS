import React, {useEffect} from "react"
import {View, Text, StyleSheet, Platform, Pressable} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"
import {router, useFocusEffect} from "expo-router"
import {textEditorStore} from "@/utils/TextEditorStore"

type TextSettingNoSaveProps = {
  label: string
  value: string
  onChangeText: (text: string) => void
  settingKey: string
}

const TextSettingNoSave: React.FC<TextSettingNoSaveProps> = ({label, value, onChangeText, settingKey}) => {
  const {theme} = useAppTheme()

  // Check for pending value when component gets focus
  useFocusEffect(
    React.useCallback(() => {
      const pendingValue = textEditorStore.getPendingValue()
      if (pendingValue && pendingValue.key === settingKey) {
        onChangeText(pendingValue.value)
      }
    }, [settingKey, onChangeText]),
  )

  const handleOpenEditor = () => {
    router.push({
      pathname: "/tpa/text-editor",
      params: {
        label,
        value,
        settingKey,
      },
    })
  }

  return (
    <View style={styles.container}>
      <Text style={[styles.label, {color: theme.colors.text}]}>{label}</Text>

      <Pressable
        style={({pressed}) => [styles.button, {borderColor: theme.colors.border}, pressed && styles.buttonPressed]}
        onPress={handleOpenEditor}
        android_ripple={{color: "rgba(0, 0, 0, 0.1)"}}>
        <Text style={[styles.buttonText, {color: theme.colors.text}]} numberOfLines={2} ellipsizeMode="tail">
          {value || "Tap to edit..."}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: "transparent",
    borderRadius: Platform.OS === "ios" ? 8 : 4,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: Platform.OS === "ios" ? 44 : 48,
    padding: Platform.OS === "ios" ? 12 : 10,
  },
  buttonPressed: {
    backgroundColor: Platform.OS === "ios" ? "rgba(0, 0, 0, 0.05)" : "transparent",
    opacity: Platform.OS === "ios" ? 0.8 : 1,
  },
  buttonText: {
    fontSize: 16,
  },
  container: {
    marginVertical: 10,
    width: "100%",
  },
  label: {
    fontSize: 16,
    marginBottom: 5,
  },
})

export default TextSettingNoSave
