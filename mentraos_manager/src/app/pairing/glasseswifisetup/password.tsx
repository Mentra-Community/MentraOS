import React, {useState} from "react"
import {View, Text, TextInput, KeyboardAvoidingView, Platform, TouchableOpacity} from "react-native"
import {useLocalSearchParams, router} from "expo-router"
import {Screen, Icon, Header} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {ViewStyle, TextStyle} from "react-native"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import ActionButton from "@/components/ui/ActionButton"

export default function WifiPasswordScreen() {
  const params = useLocalSearchParams()
  const deviceModel = (params.deviceModel as string) || "Glasses"
  const initialSsid = (params.ssid as string) || ""

  const {theme, themed} = useAppTheme()

  const [ssid, setSsid] = useState(initialSsid)
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  const handleConnect = () => {
    // console.log("3231 handleConnect called");

    if (!ssid) {
      GlobalEventEmitter.emit("SHOW_BANNER", {
        message: "Please enter a network name",
        type: "error",
      })
      return
    }

    // Navigate to connecting screen with credentials
    router.push({
      pathname: "/pairing/glasseswifisetup/connecting",
      params: {
        deviceModel,
        ssid,
        password,
      },
    })
  }

  return (
    <Screen preset="scroll" contentContainerStyle={themed($container)}>
      <Header title="Enter Glasses WiFi Details" leftIcon="caretLeft" onLeftPress={() => router.back()} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={themed($keyboardContainer)}>
        <View style={themed($content)}>
          <View style={themed($inputContainer)}>
            <Text style={themed($label)}>Network Name (SSID)</Text>
            <TextInput
              style={themed($input)}
              value={ssid}
              onChangeText={setSsid}
              placeholder="Enter network name"
              placeholderTextColor={theme.colors.textDim}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!initialSsid} // Only editable if manually entering
            />
          </View>

          <View style={themed($inputContainer)}>
            <Text style={themed($label)}>Password</Text>
            <View style={themed($passwordContainer)}>
              <TextInput
                style={themed($passwordInput)}
                value={password}
                onChangeText={setPassword}
                placeholder="Enter password"
                placeholderTextColor={theme.colors.textDim}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={themed($eyeButton)}>
                <Icon icon={showPassword ? "view" : "hidden"} size={20} color={theme.colors.textDim} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={themed($buttonContainer)}>
            <ActionButton label="Connect" onPress={handleConnect} />

            <ActionButton label="Cancel" variant="secondary" onPress={() => router.back()} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $keyboardContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.lg,
})

const $inputContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.lg,
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  fontWeight: "500",
  color: colors.text,
  marginBottom: spacing.xs,
})

const $input: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  height: 50,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.xs,
  padding: spacing.sm,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.background,
})

const $passwordContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  position: "relative",
})

const $passwordInput: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  height: 50,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.xs,
  padding: spacing.sm,
  paddingRight: 50,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.background,
})

const $eyeButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  right: spacing.sm,
  height: 50,
  width: 40,
  justifyContent: "center",
  alignItems: "center",
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginTop: spacing.xl,
  gap: spacing.md,
})
