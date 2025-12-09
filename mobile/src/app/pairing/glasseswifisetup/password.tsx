import {useLocalSearchParams, useFocusEffect} from "expo-router"
import {useState, useEffect, useCallback, useRef} from "react"
import {View, TextInput, TouchableOpacity, BackHandler} from "react-native"
import {ViewStyle, TextStyle} from "react-native"
import {ScrollView} from "react-native"
import Toast from "react-native-toast-message"

import {EyeIcon} from "@/components/icons/EyeIcon"
import {EyeOffIcon} from "@/components/icons/EyeOffIcon"
import {WifiIcon} from "@/components/icons/WifiIcon"
import {Screen, Header, Checkbox, Button, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/utils/useAppTheme"
import WifiCredentialsService from "@/utils/wifi/WifiCredentialsService"

export default function WifiPasswordScreen() {
  const params = useLocalSearchParams()
  const deviceModel = (params.deviceModel as string) || "Glasses"
  const initialSsid = (params.ssid as string) || ""
  const returnTo = params.returnTo as string | undefined
  const nextRoute = params.nextRoute as string | undefined

  const {theme, themed} = useAppTheme()
  const {push, goBack, replace} = useNavigationHistory()
  const glassesConnected = useGlassesStore(state => state.connected)
  const [ssid, setSsid] = useState(initialSsid)
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rememberPassword, setRememberPassword] = useState(true)
  const [hasSavedPassword, setHasSavedPassword] = useState(false)

  // Navigate away if glasses disconnect (but not on initial mount)
  const prevGlassesConnectedRef = useRef(glassesConnected)
  useEffect(() => {
    if (prevGlassesConnectedRef.current && !glassesConnected) {
      console.log("[WifiPasswordScreen] Glasses disconnected - navigating away")
      showAlert("Glasses Disconnected", "Please reconnect your glasses to set up WiFi.", [{text: "OK"}])
      if (returnTo && typeof returnTo === "string") {
        replace(decodeURIComponent(returnTo))
      } else {
        replace("/")
      }
    }
    prevGlassesConnectedRef.current = glassesConnected
  }, [glassesConnected, returnTo])

  const handleGoBack = useCallback(() => {
    if (returnTo && typeof returnTo === "string") {
      replace(decodeURIComponent(returnTo))
    } else {
      goBack()
    }
    return true // Prevent default back behavior
  }, [returnTo])

  // Handle Android back button
  useFocusEffect(
    useCallback(() => {
      const backHandler = BackHandler.addEventListener("hardwareBackPress", handleGoBack)
      return () => backHandler.remove()
    }, [handleGoBack]),
  )

  // Load saved password when component mounts
  useEffect(() => {
    if (initialSsid) {
      const savedPassword = WifiCredentialsService.getPassword(initialSsid)
      if (savedPassword) {
        setPassword(savedPassword)
        setHasSavedPassword(true)
        setRememberPassword(true) // Check the box if there's a saved password
      }
    }
  }, [initialSsid])

  // Handle checkbox state changes - immediately remove saved password when unchecked
  useEffect(() => {
    console.log("321321 rememberPassword", rememberPassword)
    console.log("321321 initialSsid", initialSsid)
    if (!rememberPassword && initialSsid) {
      // Remove saved credentials immediately when checkbox is unchecked
      WifiCredentialsService.removeCredentials(initialSsid)
      setHasSavedPassword(false)
      console.log("$%^&*()_321321 removed credentials")
    }
  }, [rememberPassword, initialSsid])

  const handleConnect = async () => {
    if (!ssid) {
      Toast.show({
        type: "error",
        text1: "Please enter a network name",
      })
      return
    }

    // Don't save credentials here - only save after successful connection
    // If user unchecked "Remember Password", remove any existing saved credentials
    if (!rememberPassword) {
      await WifiCredentialsService.removeCredentials(ssid)
    }

    // Navigate to connecting screen with credentials
    push("/pairing/glasseswifisetup/connecting", {
      deviceModel,
      ssid,
      password,
      rememberPassword: rememberPassword.toString(),
      returnTo,
      nextRoute,
    })
  }

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header title="Wi-Fi" leftIcon="chevron-left" onLeftPress={handleGoBack} />
      <ScrollView contentContainerStyle={themed($scrollContent)} style={{flex: 1}}>
        {/* Centered card container */}
        <View style={themed($card)}>
          {/* WiFi Icon and SSID Header */}
          <View style={themed($iconContainer)}>
            <WifiIcon size={48} color={theme.colors.palette.success500} />
          </View>

          <Text style={themed($ssidTitle)}>{ssid || "Enter Network Details"}</Text>

          {/* Manual entry shows SSID input */}
          {!initialSsid && (
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
              />
            </View>
          )}

          <View style={themed($inputContainer)}>
            <Text style={themed($label)}>Wi-Fi password</Text>
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
                {showPassword ? (
                  <EyeIcon size={24} color={theme.colors.textDim} />
                ) : (
                  <EyeOffIcon size={24} color={theme.colors.textDim} />
                )}
              </TouchableOpacity>
            </View>
            {hasSavedPassword && (
              <Text style={themed($savedPasswordText)}>✓ Password loaded from saved credentials</Text>
            )}
          </View>

          <TouchableOpacity
            style={themed($checkboxContainer)}
            onPress={() => setRememberPassword(!rememberPassword)}
            activeOpacity={0.7}
            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
            <Checkbox
              value={rememberPassword}
              onValueChange={setRememberPassword}
              containerStyle={{padding: 8, marginTop: -8}}
              inputOuterStyle={{
                backgroundColor: rememberPassword ? theme.colors.palette.success500 : theme.colors.background,
                borderColor: rememberPassword ? theme.colors.palette.success500 : theme.colors.border,
                borderWidth: 2,
              }}
              inputDetailStyle={{
                tintColor: theme.colors.palette.white,
              }}
            />
            <View style={themed($checkboxContent)}>
              <Text style={themed($checkboxLabel)}>Remember Password</Text>
              <Text style={themed($checkboxDescription)}>Save this password for future connections.</Text>
            </View>
          </TouchableOpacity>

          <View style={themed($divider)} />

          <View style={themed($buttonContainer)}>
            <Button text="Cancel" onPress={handleGoBack} preset="alternate" style={themed($cancelButton)} />
            <Button text="Connect" onPress={handleConnect} style={themed($connectButton)} />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

const $scrollContent: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexGrow: 1,
  justifyContent: "center",
  paddingVertical: spacing.s6,
})

const $card: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s6,
  borderWidth: 1,
  borderColor: colors.border,
  padding: spacing.s6,
  width: "100%",
  alignItems: "center",
})

const $iconContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s3,
})

const $ssidTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 20,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
  marginBottom: spacing.s4,
})

const $inputContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginBottom: spacing.s4,
  width: "100%",
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 16,
  fontWeight: "400",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $input: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  height: 50,
  borderRadius: spacing.s3,
  padding: spacing.s4,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.background,
})

const $passwordContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  position: "relative",
})

const $passwordInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  height: 50,
  borderRadius: spacing.s3,
  padding: spacing.s4,
  paddingRight: 50,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.background,
})

const $eyeButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  right: spacing.s3,
  height: 50,
  width: 40,
  justifyContent: "center",
  alignItems: "center",
})

const $savedPasswordText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.tint,
  marginTop: spacing.s2,
  fontStyle: "italic",
})

const $checkboxContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "flex-start",
  marginBottom: spacing.s6,
  width: "100%",
})

const $checkboxContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $checkboxLabel: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "500",
  color: colors.text,
})

const $checkboxDescription: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  color: colors.textDim,
  marginTop: 2,
})

const $divider: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  height: 1,
  backgroundColor: colors.border,
  marginTop: spacing.s2,
  marginBottom: spacing.s6,
})

const $buttonContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s3,
  width: "100%",
  justifyContent: "flex-end",
})

const $cancelButton: ThemedStyle<ViewStyle> = () => ({
  flex: 0,
  minWidth: 100,
})

const $connectButton: ThemedStyle<ViewStyle> = () => ({
  flex: 0,
  minWidth: 100,
})
